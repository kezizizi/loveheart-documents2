"""表现层：把后端模型翻译成新版前端约定的 JSON。

这是**唯一**一处「后端 → 前端」的翻译，刻意做成纯函数：不碰网络、不碰 Streamlit，
因此可以直接单测（``tests/test_payload.py``）。契约见交接文档第 3.3.1 节。

两条格式要求不是风格问题，写错会直接坏掉功能
------------------------------------------------
* ``date`` 必须补零成 ``YYYY-MM-DD`` —— 前端按**字符串**排序，写成 ``2023-9-1``
  会让时间轴顺序整个乱掉；
* ``term`` 必须是「四位年份 + 季节」（``2023秋``）—— 写成 ``23秋`` 会让学年分组塌掉。

刻意不做的两件事
----------------
1. **不算派生**（stats / groups / terms / years）。那是前端的活（`data/derive.js`），
   两边各算一套必然出现「身份栏写着 9 个部组、下面全是其他」这种自相矛盾。
2. **不把「核心内容」当成「感想」**。活动表里有两类自由文本：``reflection``（感想）
   与 ``content``（核心内容 / 环节）。新前端的实心圆点语义是「这一场留下了**你的**
   感想」，把活动描述塞进去等于替社员编造语气。所以 ``note`` 只取 ``reflection``，
   取不到就留空 —— 前端会画成空心圆点（「这场没有留下感想」）。
"""

from __future__ import annotations

from typing import Any

from config import UNKNOWN_GROUP_LABEL
from feishu import schema as S
from feishu.member_query import (
    NOT_FOUND_NAME,
    NOT_FOUND_SID,
    NOT_FOUND_SID_MISSING,
    MemberQueryResult,
)
from feishu.models import Participation
from services.membership_date import derive_membership_date, format_date

# 前端自带的五种状态 + 一种「我们这边没查成」
STATUS_OK = "OK"
STATUS_INVALID_INPUT = "INVALID_INPUT"
STATUS_NOT_FOUND_NAME = "NOT_FOUND_NAME"
STATUS_NOT_FOUND_SID = "NOT_FOUND_SID"
STATUS_NOT_FOUND_SID_MISSING = "NOT_FOUND_SID_MISSING"
#: 扩展状态：检索**一次都没成功**（权限、限流、网络）。绝不能伪装成「查无此人」——
#: 那会把社员引向补录问卷，而真正的问题在系统这一侧。
STATUS_ERROR = "ERROR"

_REASON_TO_STATUS = {
    NOT_FOUND_NAME: STATUS_NOT_FOUND_NAME,
    NOT_FOUND_SID: STATUS_NOT_FOUND_SID,
    NOT_FOUND_SID_MISSING: STATUS_NOT_FOUND_SID_MISSING,
}

#: 学期缺失时的占位，必须**能通过**前端的 ``/^(\d{4})(.*)$/``，否则学年分组会塌。
#: 用一个不含四位数字的词，前端会把它单列成一组（与旧 UI 的「未标注学期」同口径）。
UNKNOWN_TERM = "未标注学期"

#: 主表里「想对爱心社说的话」的两种列名：26-27 库叫前者，25-26 库叫后者。
JOIN_MESSAGE_FIELDS = ("想对爱心社说的话", "想说的话")
COLLEGE_FIELDS = ("院系",)


def _date(ms: int | None) -> str | None:
    """毫秒时间戳 → 补零的 ``YYYY-MM-DD``（北京时间）。"""
    if not ms:
        return None
    text = format_date(ms, "%Y-%m-%d")
    return text or None


def _text(raw: Any) -> str:
    return S.cell_text(raw).strip()


def _activity(p: Participation) -> dict[str, Any]:
    return {
        "name": p.activity_name or "",
        "term": p.term or UNKNOWN_TERM,
        "group": p.group or UNKNOWN_GROUP_LABEL,
        # 必须是数字而不是字符串：前端直接调 toFixed(1)
        "hours": float(round(p.hours, 1)),
        "date": _date(p.event_time_ms or p.record_created_ms),
        "note": (p.reflection or "").strip(),
    }


def build_member(result: MemberQueryResult) -> dict[str, Any]:
    """``MemberQueryResult`` → 前端 ``member`` 对象（**不含**派生字段）。"""
    member = result.member
    assert member is not None, "found=True 时 member 必然存在"

    membership = derive_membership_date(member)
    join_date = _date(membership.date_ms)

    return {
        "name": member.name,
        "sid": member.sid,
        "college": _text(member.value(*COLLEGE_FIELDS)),
        "joinDate": join_date,
        # filled = 「入社日期」字段的真实值；created = 回退到首次入档时间；
        # none = 两样都没有（前端显示「—」，不再补一句不实的说明）
        "joinDateSource": (
            "filled" if (join_date and not membership.is_estimated)
            else "created" if join_date
            else "none"
        ),
        # 同行伙伴：只出人数不出姓名。统计不到时是 None，前端显示「—」而不是 0。
        "companions": result.co_partners,
        # 缺失时**不编造**：前端对缺字段是防御式渲染，整个区块不显示
        "joinMessage": _text(member.value(*JOIN_MESSAGE_FIELDS)),
        "activities": [_activity(p) for p in result.participations],
    }


def build_payload(
    result: MemberQueryResult,
    *,
    degraded: bool = False,
    status: str | None = None,
) -> dict[str, Any]:
    """``MemberQueryResult`` → 前端渲染所需的那一份 JSON。

    ``status`` 只在调用方已经知道更准确的原因时传入（如入参为空、整条链路报错）。
    """
    if status:
        return {"status": status}

    if not result.found:
        mapped = _REASON_TO_STATUS.get(result.not_found_reason or "")
        # 归因拿不到 = 检索压根没成功过 —— 如实说「没查成」，不要伪装成「查无此人」
        return {"status": mapped or STATUS_ERROR}

    return {
        "status": STATUS_OK,
        "member": build_member(result),
        "degraded": bool(degraded),
    }


def payload_for_error() -> dict[str, Any]:
    return {"status": STATUS_ERROR}


def payload_for_invalid_input() -> dict[str, Any]:
    return {"status": STATUS_INVALID_INPUT}
