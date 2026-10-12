"""「与 N 位伙伴同行」在查询里并发取回的回归测试。

为什么值得单独守
----------------
新前端的身份栏默认就显示「同行 N 位伙伴」，于是这项统计从「用户点按钮才做」
变成了「每次查询都做」。它是整条链路里除了取数之外**唯一**会额外访问活动表的地方，
所以两条边界必须钉死：

1. **范围不许因此变宽**：扫姓名的表集合，必须**落在**本来就要取数的那几张关联表里
   （红线 3.1）。多扫一张都是烧飞书配额。
2. **只投影姓名一列**：绝不能顺带把别人的感想、正文拉进内存（红线 3.4 的精神）。

还有一处口径：统计不到时必须是 ``None``，不能退回 ``0`` —— 0 会谎称「没有伙伴」。
"""

from __future__ import annotations

from feishu.member_query import (
    collect_records,
    linked_tables,
    query_member,
    scan_table_names,
)
from feishu.models import ActivityTable
from feishu.registry import build_registry

MEMBER = ("张三", "2300017473")
NAME_COLUMN = "姓名"


def _activity_tables(registry) -> set[str]:
    return set(registry.by_table_id())


def _scanned_tables(client, registry) -> set[str]:
    """这次查询里，被「只投影一列姓名」扫过的活动表。"""
    activity = _activity_tables(registry)
    return {
        table_id
        for op, table_id, names in client.projections
        if op == "search_records"
        and table_id in activity
        and len(names) == 1
        and NAME_COLUMN in names[0]
    }


def _touched_tables(client, registry) -> set[str]:
    """这次查询碰过的活动表（不论请求类型）。"""
    activity = _activity_tables(registry)
    return {
        call[2]
        for call in client.calls
        if call[0] in ("search_records", "batch_get_records") and call[2] in activity
    }


def _linked_member(client, specs):
    registry = build_registry(client, specs)
    member = query_member(client, registry, specs, *MEMBER).member
    assert member is not None
    return registry, member


# --------------------------------------------------------------------------
# 默认（不要伙伴）时行为与从前完全一致
# --------------------------------------------------------------------------


def test_without_want_partners_nothing_extra_is_scanned(specs, fixture_client_with_records):
    client = fixture_client_with_records
    registry = build_registry(client, specs)
    result = query_member(client, registry, specs, *MEMBER)

    assert result.co_partners is None, "没要求统计就不该有数字"
    assert _scanned_tables(client, registry) == set(), "没要求统计就不该扫姓名列"


# --------------------------------------------------------------------------
# 打开之后：范围、投影、口径
# --------------------------------------------------------------------------


def test_want_partners_counts_other_members(specs, fixture_client_with_records):
    client = fixture_client_with_records
    registry = build_registry(client, specs)
    result = query_member(client, registry, specs, *MEMBER, want_partners=True)

    assert result.found
    # 张三参与过的活动表里出现过的其他姓名只有「李四」；
    # 安宁疗护表里那个同名不同学号的「张三」必须被当成自己排除掉。
    assert result.co_partners == 1
    assert result.co_partners_truncated is False


def test_partner_scan_never_widens_scope(specs, fixture_client_with_records):
    """🚩 扫姓名的表必须落在本来就要取数的关联表里，一张都不许多。"""
    client = fixture_client_with_records
    registry, member = _linked_member(client, specs)
    expected = {t.table_id for t, _ in linked_tables(registry, member)}
    assert expected, "前提：张三确实关联了活动表"

    client.calls.clear()
    client.projections.clear()
    collect_records(client, registry, member, with_partners=True)

    assert _scanned_tables(client, registry) <= expected
    assert _touched_tables(client, registry) <= expected
    assert _scanned_tables(client, registry), "前提：这次确实扫过姓名列"


def test_partner_scan_projects_only_the_name_column(specs, fixture_client_with_records):
    """扫姓名只许要一列，而且那一列必须是「姓名」。"""
    client = fixture_client_with_records
    registry, member = _linked_member(client, specs)
    client.projections.clear()

    got = collect_records(client, registry, member, with_partners=True)
    assert got.tables_scanned >= 1

    activity = _activity_tables(registry)
    for op, table_id, names in client.projections:
        if op == "search_records" and table_id in activity:
            assert len(names) == 1 and NAME_COLUMN in names[0], (
                f"扫姓名列时只该投影姓名，实际 {names!r}"
            )


def test_partner_scan_failure_yields_none_not_zero(specs, fixture_client_with_records):
    """姓名列全都扫不动 → ``None``（前端显示「—」），绝不是 0。

    同时主流程不受影响：参与记录照样取得到。
    """
    client = fixture_client_with_records
    registry, member = _linked_member(client, specs)

    original = client.search_records

    def name_scan_fails(base_token, table_id, *, field_names=None, **kw):
        names = tuple(field_names or ())
        if len(names) == 1 and NAME_COLUMN in names[0]:
            raise RuntimeError("模拟：姓名列扫不动")
        return original(base_token, table_id, field_names=field_names, **kw)

    client.search_records = name_scan_fails  # type: ignore[method-assign]

    got = collect_records(client, registry, member, with_partners=True)
    assert got.tables_scanned == 0
    assert got.partner_names == frozenset()
    assert got.participations, "伙伴统计失败不该连累参与记录"


def test_truncation_flag_is_set_when_over_cap(specs, fixture_client_with_records):
    client = fixture_client_with_records
    registry, member = _linked_member(client, specs)

    got = collect_records(client, registry, member, with_partners=True, partner_cap=1)
    assert got.partners_truncated is True


def test_scan_table_names_distinguishes_unscannable_from_empty():
    """没有姓名列 = 扫不动（``None``），与「扫到但空」（``set()``）是两件事。"""

    class Recorder:
        def __init__(self):
            self.called = 0

        def search_records(self, *a, **kw):
            self.called += 1
            return []

    client = Recorder()
    without_name = ActivityTable(
        base_key="base_25_26",
        base_token="tok",
        table_id="tblA",
        name="某活动",
        safe_fields=("感想",),
    )
    assert scan_table_names(client, without_name) is None
    assert client.called == 0, "没有姓名列就不该发请求"

    with_name = ActivityTable(
        base_key="base_25_26",
        base_token="tok",
        table_id="tblA",
        name="某活动",
        safe_fields=(NAME_COLUMN,),
    )
    assert scan_table_names(client, with_name) == set()
    assert client.called == 1
