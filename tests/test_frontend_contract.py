"""前后端契约的无浏览器守卫。

浏览器里的验收在 ``static/_work/run-selftest.mjs``（156 项）与
``static/_work/e2e-streamlit.mjs``（49 项）里，但它们要 Node + Edge，CI 上不一定有。
这里放的是**不需要浏览器**也能守住的那部分契约 —— 每一条都对应一个真实会坏的方式：

* ``index.html`` **静态引入** ``mock-db.js`` → 假数据盖住真实数据（原始交接文档 §4.1 第 6 步）；
* 资源版本号四处不一致 → 浏览器旧缓存盖住新样式/新 JS（§5.6）；
* 组件根目录里混进开发工具 → 它们会被 HTTP 公开（组件文件服务会提供根目录下的一切）；
* 后端载荷多出/少了键 → 前端静默读不到值（不报错，只是显示空）；
* 后端顺手算了派生字段 → 与前端各算一套（§2.3②）。
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from config import PROJECT_ROOT
from feishu.member_query import MemberQueryResult
from feishu.models import Participation
from ui import payload as P

WEB = PROJECT_ROOT / "static" / "web"
WORK = PROJECT_ROOT / "static" / "_work"

INDEX = WEB / "index.html"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


# --------------------------------------------------------------------------
# 文件与目录
# --------------------------------------------------------------------------


def test_component_dir_has_an_index():
    assert INDEX.is_file(), f"组件根目录必须有 index.html：{INDEX}"


def test_embed_points_at_the_component_dir():
    """``ui/embed.py`` 声明的组件目录必须就是上面那个（不能是别处的一份副本）。"""
    from ui import embed

    assert Path(embed.WEB_DIR).resolve() == WEB.resolve()


def test_dev_tooling_is_not_inside_the_component_dir():
    """``static/_work`` 与 ``static/前端契约.md`` **不能**放进组件目录。

    组件文件服务会把组件根目录下的任何文件按 URL 提供出去 ——
    自检页、截图脚本、设计/契约文档放进去就等于公开。只有 ``static/web/``
    是组件根目录，它的**同级**才是安全的。
    """
    assert WORK.is_dir()
    assert not (WEB / "_work").exists(), "开发工具不能放进被公开的组件目录"
    for leaked in ("selftest.html", "serve.py", "e2e-streamlit.mjs"):
        assert not (WEB / leaked).exists(), f"{leaked} 不应出现在组件目录里"

    docs = sorted(p.name for p in WEB.rglob("*.md"))
    assert not docs, f"组件目录里的文档会被 HTTP 公开，{docs} 应放到 static/ 同级"
    assert (PROJECT_ROOT / "static" / "前端契约.md").is_file(), "前端契约文档应当在 static/ 下"


# --------------------------------------------------------------------------
# index.html：引用了什么、没引用什么
# --------------------------------------------------------------------------


def test_index_does_not_statically_load_the_demo_database():
    """🚩 假数据库必须**动态**加载（只有独立形态才加载）。

    静态挂上去的后果：接口通了、页面却永远显示演示数据。
    只查真正的引用（`<script src>` / `<link href>`）—— 注释里提到文件名不算。
    """
    html = _read(INDEX)
    refs = re.findall(r'(?:src|href)="([^"]+)"', html)
    offenders = [r for r in refs if "mock-db" in r]
    assert not offenders, (
        f"index.html 不得静态引入 {offenders} —— 它由 data/bridge.js 在独立形态下按需加载"
    )


def test_index_loads_the_three_runtime_scripts_in_order():
    html = _read(INDEX)
    order = [html.find("data/derive.js"), html.find("data/bridge.js"), html.find("app.js")]
    assert all(i >= 0 for i in order), f"index.html 必须引用三个脚本，实际 {order}"
    assert order == sorted(order), "脚本顺序必须是 derive → bridge → app（后者依赖前者）"


def test_every_referenced_local_file_exists():
    html = _read(INDEX)
    refs = re.findall(r'(?:src|href)="([^"?]+)', html)
    for ref in refs:
        if ref.startswith(("http", "#")):
            continue
        assert (WEB / ref).is_file(), f"index.html 引用了不存在的文件：{ref}"


# --------------------------------------------------------------------------
# 资源版本号必须一致（§5.6）
# --------------------------------------------------------------------------


def _versions_in(text: str) -> set[str]:
    return set(re.findall(r"\?v=([0-9a-zA-Z]+)", text))


def test_asset_version_is_consistent_everywhere():
    """改了任何图片或样式就必须推进版本号；四处不一致会出现「改了看不到」。

    徽章文件名固定不变，运行时拼接路径由 ``derive.js`` 的 ``ASSET_V`` 给出 ——
    这一处最容易漏，所以它是唯一真源，别处必须与它相同。
    """
    derive = _read(WEB / "data" / "derive.js")
    declared = re.search(r"ASSET_V\s*=\s*'([^']+)'", derive)
    assert declared, "derive.js 里应当有 ASSET_V 常量"
    expected = declared.group(1)

    for name in ("index.html", "app.js", "style.css"):
        found = _versions_in(_read(WEB / name))
        assert found, f"{name} 里应当带资源版本号"
        assert found == {expected}, f"{name} 的版本号 {found} 与 derive.js 的 {expected} 不一致"


def test_every_group_mark_file_exists():
    """部组徽记是运行时拼路径的，写错只会显示空白，肉眼极易漏。"""
    derive = _read(WEB / "data" / "derive.js")
    names = set(re.findall(r"'(?:护老部|无障碍部|儿童部|手语分社|资助部|组织部|宣传部|项目组|外联部|其他)':\s*'([a-z]+)'", derive))
    assert len(names) == 10, f"应当有 10 枚徽记（9 个部组 + 其他），实际 {sorted(names)}"
    for stem in names:
        assert (WEB / "assets" / "marks" / f"{stem}-ink.png").is_file(), f"缺少徽记 {stem}-ink.png"


def test_app_does_not_reach_for_the_demo_database():
    """渲染层不该知道演示数据的存在 —— 数据来源只有 ``bridge.js`` 知道。"""
    assert "MOCK_DB" not in _read(WEB / "app.js")


# --------------------------------------------------------------------------
# 载荷键名：后端发什么，前端就读什么
# --------------------------------------------------------------------------

_MEMBER_KEYS = {
    "name", "sid", "college", "joinDate", "joinDateSource",
    "companions", "joinMessage", "activities",
}
_ACTIVITY_KEYS = {"name", "term", "group", "hours", "date", "note"}


def _one_result() -> MemberQueryResult:
    from tests.test_payload import _participation, _result

    return _result([_participation()])


def test_ok_payload_has_exactly_the_agreed_keys():
    p = P.build_payload(_one_result())
    assert set(p) == {"status", "member", "degraded"}, set(p)
    assert set(p["member"]) == _MEMBER_KEYS, set(p["member"]) ^ _MEMBER_KEYS
    assert set(p["member"]["activities"][0]) == _ACTIVITY_KEYS


def test_payload_does_not_carry_derived_fields():
    """派生字段由前端 ``derive.js`` 算，后端发一份就会各算各的。"""
    p = P.build_payload(_one_result())
    for key in ("stats", "groups", "terms", "years"):
        assert key not in p
        assert key not in p["member"]


def test_frontend_reads_exactly_those_keys():
    """反向确认：前端读的每个成员字段都真的被读到了（后端发错名就是静默的空值）。

    ``joinDate`` / ``companions`` / ``activities`` 由 ``derive.js`` 消费；
    ``joinDateSource`` / ``joinMessage`` 由视图层 ``app.js`` 消费。
    """
    derive = _read(WEB / "data" / "derive.js")
    app = _read(WEB / "app.js")
    for key in ("joinDate", "companions", "activities"):
        assert key in derive, f"derive.js 应当读 member.{key}"
    for key in ("joinDateSource", "joinMessage"):
        assert key in app, f"app.js 应当读 member.{key}"
    # 后端内部字段名不该泄漏到前端
    for internal in ("event_time_ms", "record_created_ms", "raw_fields"):
        assert internal not in derive, f"{internal} 是后端内部名，不该出现在前端"
        assert internal not in app, f"{internal} 是后端内部名，不该出现在前端"


# --------------------------------------------------------------------------
# 失败码
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "status",
    [
        P.STATUS_OK,
        P.STATUS_INVALID_INPUT,
        P.STATUS_NOT_FOUND_NAME,
        P.STATUS_NOT_FOUND_SID,
        P.STATUS_NOT_FOUND_SID_MISSING,
        P.STATUS_ERROR,
    ],
)
def test_frontend_has_copy_for_every_status(status):
    """每个后端可能发出的 status，前端都必须有对应文案（漏一个就落回兜底文案）。"""
    app = _read(WEB / "app.js")
    if status == P.STATUS_OK:
        return  # OK 走渲染分支，不是文案
    assert re.search(rf"\b{status}\s*:", app), f"app.js 的 NOTICES 里缺少 {status} 的文案"
