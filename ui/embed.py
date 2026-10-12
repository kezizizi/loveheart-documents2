"""表现层：把新版前端（``static/web``）挂到 Streamlit 上。

怎么挂的
--------
用**自定义组件**（``st.components.v1.declare_component(path=...)``）把 ``static/web``
整个目录交给 Streamlit 的组件文件服务。于是：

* 前端拿到一个**真实 URL** —— ``/component/ui.embed.ax_footprint/index.html``，
  所以 ``style.css`` / ``app.js`` / ``assets/**`` 的相对路径**原样可用**，
  ``location.search``、``window.print()``、CSV 下载也都是原生行为，一点不用改；
* 不需要把仓库根目录挂成静态目录 —— **交接文档 §0.2 那条唯一的安全红线自动消失**：
  被 HTTP 公开的只有 ``static/web/`` 这一个目录，``.streamlit/secrets.toml``、
  ``config.py``、``docs/*.xlsx`` 一律不可达（组件文件服务还会挡住 ``..`` 越界）。

数据怎么走
----------
``{name, sid}`` 由前端经组件协议回传 → 这里查飞书 → 把结果放进组件参数 ``result``
推回去。前端只拿到 ``status / member / degraded``，**派生全部在前端算**
（``static/web/data/derive.js``），两边不各算一套。

缓存与红线
----------
* 活动注册表：``st.cache_data`` TTL 24 小时，**全局共用**。``load_registry`` 刻意
  **不收任何参数** —— 缓存键里掺进会话级的东西，每个新访客都会重建一次（约 175 次
  请求），而飞书 API 有月度配额。这条原样保留自旧前端（红线 3.9）。
* 结果缓存 10 分钟，``SchemaChangedError`` 触发「重建注册表 + 只重试一次」。
"""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path
from typing import Callable

import streamlit as st
import streamlit.components.v1 as components

from config import (
    DEFAULT_MEMBER_TTL,
    DEFAULT_REGISTRY_TTL,
    ORG_NAME,
    PROJECT_ROOT,
    Settings,
    load_settings,
)
from feishu import BitableClient, FeishuHttpClient
from feishu.member_query import MemberQueryResult, query_member
from feishu.models import ActivityRegistry
from feishu.registry import build_registry
from services.schema_refresh import with_schema_refresh
from ui import payload as P

_LOGGER = logging.getLogger(__name__)

DEMO_ENV = "AX_DEMO"
WEB_DIR: Path = PROJECT_ROOT / "static" / "web"
_COMPONENT_KEY = "ax_footprint"
_PAGE_ICON = WEB_DIR / "assets" / "club-seal.png"

#: 判定为「没查成」时，等多久再重试一次。限流与网络抖动都是秒级的。
RETRY_DELAY_SECONDS = 1.5

#: 允许从宿主页面 URL 透传给前端的调试开关（纯展示用，不参与任何数据逻辑）
_FORWARDED_PARAMS = ("still", "view", "open", "rip", "delay", "degraded", "name", "sid")

_footprint = components.declare_component("ax_footprint", path=str(WEB_DIR))


def _mask(name: str) -> str:
    """日志里出现的姓名一律脱敏（与 scripts/verify_live.py 同口径）。"""
    text = (name or "").strip()
    return (text[0] + "＊" * (len(text) - 1)) if text else "(空)"


# --------------------------------------------------------------------------
# 资源与缓存
# --------------------------------------------------------------------------


def demo_mode() -> bool:
    """``AX_DEMO=1`` 时用内存假数据，便于没有密钥也能预览界面。"""
    return os.environ.get(DEMO_ENV, "").strip().lower() in {"1", "true", "yes", "on"}


@st.cache_resource(show_spinner=False)
def get_settings() -> Settings:
    return load_settings(require_credentials=not demo_mode())


@st.cache_resource(show_spinner=False)
def get_client() -> BitableClient:
    if demo_mode():
        from feishu.fake import build_fixture_client

        return build_fixture_client(records_file="records.json")
    settings = get_settings()
    return FeishuHttpClient(
        settings.app_id, settings.app_secret, max_workers=settings.max_workers
    )


@st.cache_data(ttl=DEFAULT_REGISTRY_TTL, show_spinner=False)
def load_registry() -> ActivityRegistry:
    """全量活动注册表。

    ⚠️ **刻意不收任何参数**：缓存键里一旦掺进会话级的东西（例如 nonce），
    每个新访客都会重建一次（约 175 次请求），而飞书 API 有月度配额。
    """
    settings = get_settings()
    return build_registry(
        get_client(),
        settings.bases,
        max_workers=settings.max_workers,
    )


@st.cache_data(ttl=DEFAULT_MEMBER_TTL, show_spinner=False)
def run_query(name: str, sid: str) -> MemberQueryResult:
    """查一个人；``want_partners=True`` 让同行伙伴与活动记录**在同一批请求里**取回。"""
    return query_with_retry(lambda: _query_once(name, sid))


def _query_once(name: str, sid: str) -> MemberQueryResult:
    settings = get_settings()
    client = get_client()

    def run() -> MemberQueryResult:
        # 每次都在 run 内部取注册表：重建之后这里才能拿到新的那份
        return query_member(
            client,
            load_registry(),
            settings.bases,
            name,
            sid,
            max_workers=settings.max_workers,
            want_partners=True,
        )

    # 骨干改名或删列之后，缓存了 24 小时的旧字段名会让查询整体失败。
    # 这里丢掉过时的注册表重试一次，用户端是无感的。
    return with_schema_refresh(run, load_registry.clear)


# --------------------------------------------------------------------------
# 「没查成」与「查无此人」的分界（红线）
# --------------------------------------------------------------------------


class QueryUnavailable(RuntimeError):
    """取数失败 —— **不是**「查无此人」。

    ``pick_not_found_reason`` 只有在**每个库的检索都失败了**时才返回 ``None``，
    所以 ``found=False`` 且归因为 ``None`` 的含义是「我们根本不知道这个人在不在
    档案里」，而不是一个查询结果。把它当成结果返回，用户会被引向补录问卷，
    而问题其实在系统这一侧（限流 / 网络抖动 / 权限）。

    ⚠️ 用**抛异常**而不是返回失败值来表达它，还有一个关键作用：
    ``st.cache_data`` **不缓存抛异常的结果**。返回失败值会被缓存住 10 分钟，
    于是用户「再试一次」拿到的还是同一个失败 —— 这正是「一直这样的话」的成因。
    """


def is_unavailable(result: MemberQueryResult) -> bool:
    """这次是「没查成」而不是「查无此人」吗？

    判据只有一条，而且**语义上是空真的**：``found=False`` 且归因 ``None``。
    """
    return (not result.found) and result.not_found_reason is None


def query_with_retry(
    once: Callable[[], MemberQueryResult],
    *,
    delay: float | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> MemberQueryResult:
    """跑一次；只有「没查成」才等一拍重试一次；仍然没查成就抛 :class:`QueryUnavailable`。

    「查无此人」**不重试**：那是确定的答案，重试只是白烧 API 配额。
    重试只针对基础设施失败 —— 限流与网络抖动都是秒级的，等一拍往往就好了。
    """
    pause = RETRY_DELAY_SECONDS if delay is None else delay

    result = once()
    if not is_unavailable(result):
        return result

    sleep(pause)
    result = once()
    if not is_unavailable(result):
        return result

    detail = "；".join(result.errors[:3]) or "主表检索未成功，且没有留下错误信息"
    raise QueryUnavailable(detail)


def refresh() -> None:
    """丢掉注册表与查询缓存，下一次访问重新探测（对所有人生效，刻意的）。"""
    load_registry.clear()
    run_query.clear()


def degraded_mode() -> bool:
    """部组是不是因为缺 ``base:block:read`` 而全部退化成「其他」。

    ``blocks_degraded`` 由客户端在降级成「扁平表列表」时置位。新前端必须把这个
    事实**可见地**告诉社员（交接文档 §2.2 第 4 条），不能悄悄显示。
    """
    try:
        return bool(getattr(get_client(), "blocks_degraded", False))
    except Exception:  # noqa: BLE001 - 拿不到就当没降级，不影响主流程
        return False


# --------------------------------------------------------------------------
# 查询 → 前端 JSON
# --------------------------------------------------------------------------


def query_payload(name: str, sid: str) -> dict:
    """查一次并翻译成前端契约。**任何失败都不抛**，一律降级成一种 status。

    ⚠️ ``build_payload`` 也必须在 try 里面：它是我们自己的翻译代码，真出了 bug
    也不该让整页变成「启动失败」—— 用户看到的应该是一条正常的提示，
    而完整栈进服务端日志。
    """
    name = (name or "").strip()
    sid = (sid or "").strip()
    if not name or not sid:
        return P.payload_for_invalid_input()
    try:
        result = run_query(name, sid)
        return P.build_payload(result, degraded=degraded_mode())
    except QueryUnavailable as exc:
        # 这不是「查无此人」，是「这次没查成」。日志里留下可执行的原因（姓名脱敏）。
        _LOGGER.warning("取数失败（非查无此人）｜%s｜%s", _mask(name), exc)
        return P.payload_for_error()
    except Exception:  # noqa: BLE001 - 页面级兜底，绝不给用户白屏
        _LOGGER.exception("查询社员足迹失败（%s）", _mask(name))
        return P.payload_for_error()


# --------------------------------------------------------------------------
# 宿主外壳
# --------------------------------------------------------------------------


def _first(value: object) -> str:
    """``st.query_params`` 的值可能是 str，也可能是 list[str]。"""
    if isinstance(value, (list, tuple)):
        value = value[0] if value else ""
    return str(value or "")


def _read_query() -> tuple[str, str]:
    return (
        _first(st.query_params.get("name")).strip(),
        _first(st.query_params.get("sid")).strip(),
    )


def _front_params() -> dict[str, str]:
    """把宿主 URL 上的调试开关透传给前端（截图、预展开等）。"""
    out: dict[str, str] = {}
    for key in _FORWARDED_PARAMS:
        value = _first(st.query_params.get(key)).strip()
        if value:
            out[key] = value
    return out


def _sync_query_params(value: object) -> None:
    """把前端提交的姓名/学号写回宿主 URL。

    这样结果页可刷新、可分享（旧前端只支持「带参数的首次进入」）。只在**真的变了**
    的时候重跑一次，所以不会自激；重跑那一轮命中的是缓存，不会多打飞书接口。
    """
    if not isinstance(value, dict):
        return
    name = str(value.get("name") or "").strip()
    sid = str(value.get("sid") or "").strip()
    if not name or not sid:
        return
    if _read_query() == (name, sid):
        return
    st.query_params["name"] = name
    st.query_params["sid"] = sid
    st.rerun()


_SHELL_CSS = """
<style>
  /* 把 Streamlit 自己的外壳收干净，让组件铺满整页 ——
     新前端自带品牌栏与整页纸底，外面再套一层容器会出现双层留白。 */
  [data-testid="stHeader"], [data-testid="stToolbar"], [data-testid="stDecoration"],
  [data-testid="stStatusWidget"], #MainMenu, footer { display: none !important; }
  .stApp, [data-testid="stAppViewContainer"] { background: #fbfaf7; }
  [data-testid="stMainBlockContainer"], .block-container {
    padding: 0 !important; max-width: 100% !important;
  }
  /* ⚠️ 这里**不要**碰 `[data-testid="stMain"]` 的 overflow。
     它就是 Streamlit 的滚动容器（实测 scrollHeight 1615 / clientHeight 708），
     而它的父级 stAppViewContainer 是 overflow:hidden、文档本身也不滚。
     一旦把它设成 visible，全页就**只能滚不动**：
       处 置 前：stMain overflowY=visible → 滚轮完全无效
       处 置 后：保持 Streamlit 默认 auto → 正常滚动
     守卫测试：static/_work/e2e-streamlit.mjs 的「宿主可滚动」几条。 */
  [data-testid="stVerticalBlock"] { gap: 0 !important; }
  [data-testid="stCustomComponentV1"] { width: 100%; }
  [data-testid="stCustomComponentV1"] iframe { display: block; width: 100%; border: 0; }
</style>
"""


def _inject_shell_css() -> None:
    st.markdown(_SHELL_CSS, unsafe_allow_html=True)


def render() -> None:
    """Streamlit 入口：只做「读参数 → 查询 → 交给组件渲染」。"""
    st.set_page_config(
        page_title=f"爱心足迹 · {ORG_NAME}",
        page_icon=str(_PAGE_ICON) if _PAGE_ICON.exists() else "❤️",
        layout="wide",
        initial_sidebar_state="collapsed",
    )
    _inject_shell_css()

    name, sid = _read_query()
    # 只有姓名学号**同时**给了才先查；只给一半时把表单填上让用户补完更友好
    payload = query_payload(name, sid) if (name and sid) else None

    value = _footprint(
        result=payload,
        params=_front_params(),
        key=_COMPONENT_KEY,
        default=None,
    )
    _sync_query_params(value)
