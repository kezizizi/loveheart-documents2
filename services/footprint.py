"""业务层：学时汇总、时间轴与参与浓度聚合。

全部是纯函数，不碰网络、不碰 Streamlit，便于单元测试。
"""

from __future__ import annotations

from typing import Any, Iterable, Sequence

from config import (
    CO_PARTNER_CAP,
    UNKNOWN_GROUP_LABEL,
    group_color,
    term_sort_value,
)
from feishu.models import ActivityRegistry, Footprint, Participation, TimelineItem
from feishu.protocol import BitableClient
from services.identity import MergedMember

LOW_CONFIDENCE = "low"

# 时间轴排序的四个层级（层级越小越靠前）
_TIER_EVENT_TIME = 0
_TIER_TERM = 1
_TIER_CREATED = 2
_TIER_UNKNOWN = 3


# --------------------------------------------------------------------------
# 时间轴
# --------------------------------------------------------------------------


def timeline_sort_key(p: Participation) -> tuple[int, float, str]:
    """三级回退排序键：参与时间 > 学期标签 > 记录创建时间。"""
    if p.event_time_ms:
        return (_TIER_EVENT_TIME, float(p.event_time_ms), p.activity_name)
    term_value = term_sort_value(p.term)
    if term_value is not None:
        return (_TIER_TERM, term_value, p.activity_name)
    if p.record_created_ms:
        return (_TIER_CREATED, float(p.record_created_ms), p.activity_name)
    return (_TIER_UNKNOWN, 0.0, p.activity_name)


def build_timeline(
    participations: Sequence[Participation],
) -> tuple[TimelineItem, ...]:
    ordered = sorted(participations, key=timeline_sort_key)
    return tuple(
        TimelineItem(
            activity_name=p.activity_name,
            group=p.group,
            term=p.term,
            event_time_ms=p.event_time_ms or p.record_created_ms,
            hours=p.hours,
            reflection=p.reflection,
            confidence=p.confidence,
        )
        for p in ordered
    )


# --------------------------------------------------------------------------
# 聚合
# --------------------------------------------------------------------------


def _dedupe(values: Iterable[str]) -> tuple[str, ...]:
    seen: set[str] = set()
    out: list[str] = []
    for v in values:
        if v not in seen:
            seen.add(v)
            out.append(v)
    return tuple(out)


def summarize(participations: Sequence[Participation]) -> Footprint:
    """汇总为一份爱心足迹。"""
    total_hours = round(sum(p.hours for p in participations), 1)
    groups = _dedupe(
        (p.group or UNKNOWN_GROUP_LABEL) for p in participations
    )

    hour_by_group: dict[str, float] = {}
    count_by_term: dict[str, int] = {}
    for p in participations:
        key = p.group or UNKNOWN_GROUP_LABEL
        hour_by_group[key] = round(hour_by_group.get(key, 0.0) + p.hours, 1)
        term_key = p.term or "未标注学期"
        count_by_term[term_key] = count_by_term.get(term_key, 0) + 1

    return Footprint(
        total_hours=total_hours,
        activity_count=len(participations),
        distinct_activity_count=len({p.table_id for p in participations}),
        groups=groups,
        timeline=build_timeline(participations),
        hour_by_group=hour_by_group,
        count_by_term=_sorted_terms(count_by_term),
        confidence_low=sum(
            1 for p in participations if p.confidence == LOW_CONFIDENCE
        ),
    )


def _sorted_terms(counts: dict[str, int]) -> dict[str, int]:
    def key(item: tuple[str, int]) -> tuple[int, float | str]:
        value = term_sort_value(item[0])
        return (0, value) if value is not None else (1, item[0])

    return dict(sorted(counts.items(), key=key))


def group_breakdown(
    participations: Sequence[Participation],
) -> list[dict[str, Any]]:
    """按部组拆分，供 UI 渲染彩色标签。"""
    buckets: dict[str, dict[str, Any]] = {}
    for p in participations:
        key = p.group or UNKNOWN_GROUP_LABEL
        bucket = buckets.setdefault(
            key, {"group": key, "hours": 0.0, "count": 0, "color": group_color(key)}
        )
        bucket["hours"] = round(bucket["hours"] + p.hours, 1)
        bucket["count"] += 1

    return sorted(buckets.values(), key=lambda b: (-b["count"], b["group"]))


# --------------------------------------------------------------------------
# 与 N 位伙伴同行（按需计算）
# --------------------------------------------------------------------------


def count_co_partners(
    client: BitableClient,
    registry: ActivityRegistry,
    member: MergedMember,
    participations: Sequence[Participation],
    *,
    cap: int = CO_PARTNER_CAP,
) -> tuple[int | None, bool]:
    """统计同场活动的其他参与者数量。

    需要扫活动表的「姓名」列，成本较高，因此：
    * 最多扫 ``cap`` 张表；超出则把 truncated 置 True；
    * 单表失败静默跳过，不影响其他表。

    返回 ``(人数, 是否被截断)``；一张表都扫不到时返回 ``(None, False)``。

    取数细节（只投影姓名列、失败与空集的三态区分）统一在
    ``feishu.member_query.scan_table_names`` 里，这里不重复实现一遍。

    注意上面那句 import 必须写在函数体里：``feishu.member_query`` 依赖
    ``services.identity``，而 ``services/__init__`` 又会导入本模块 ——
    在模块顶层 import 会立刻撞成循环导入。
    """
    from feishu.member_query import scan_table_names

    table_ids = _dedupe(p.table_id for p in participations)
    truncated = len(table_ids) > cap
    table_ids = table_ids[:cap]

    by_id = registry.by_table_id()
    names: set[str] = set()
    scanned = 0

    for table_id in table_ids:
        table = by_id.get(table_id)
        if table is None:
            continue
        found = scan_table_names(client, table)
        if found is None:
            continue
        scanned += 1
        names |= found

    names.discard(member.name.replace(" ", ""))
    if scanned == 0:
        return None, truncated
    return len(names), truncated
