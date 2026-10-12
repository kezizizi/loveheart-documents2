"""学期回退口径的回归测试（``config.term_from_date`` + ``ui/payload._activity``）。

背景：旧逻辑只认**表名 / 文件夹名**。有一批活动表两者都不含学期信息
（实测：「9月21日宣传部第一次例会」，文件夹只写了部组名），于是记录虽然抓到了
明确的参与时间 2025-09-21，仍然落进「未标注学期」，前端就多出一个空的学年分组。

现在的口径是三代：
1. **表名 / 文件夹名优先**（骨干维护的事实）；
2. 它们给不出学期时，才按**活动日期**归入对应学期；
3. 连日期都没有 → ``未标注学期``。

下面第一组钉死学年分界（尤其 1、2 月必须退一年），第二组钉死「优先级不能反过来」。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from itertools import count

import pytest

from config import term_from_date
from feishu.member_query import MemberQueryResult
from feishu.models import MemberRecord, Participation
from services.identity import merge_members
from services.membership_date import term_from_ms
from ui import payload as P

#: 学年分界的全部「拐点」：每个月都取 1 日与月末最后一天，逐个钉死。
#: 表里是 (年, 月, 日, 期望学期) —— 秋 = 9~12 月 + 次年 1~2 月，春 = 3~8 月。
_BOUNDARIES = [
    (2025, 1, 1, "2024秋"),   # 跨年：1 月属于**上一年**的秋季学期
    (2025, 1, 31, "2024秋"),
    (2025, 2, 1, "2024秋"),
    (2025, 2, 28, "2024秋"),  # 2 月最后一天仍是秋
    (2025, 3, 1, "2025春"),   # 3 月 1 日翻到春
    (2025, 6, 30, "2025春"),
    (2025, 7, 1, "2025春"),   # 暑假仍算春季学期（口径：3–8 月为春）
    (2025, 8, 31, "2025春"),  # 8 月最后一天仍是春
    (2025, 9, 1, "2025秋"),   # 9 月 1 日翻到秋
    (2025, 9, 21, "2025秋"),  # ← 用户报的那条活动
    (2025, 12, 31, "2025秋"),
    (2026, 1, 1, "2025秋"),   # 跨到 2026 年，仍是 2025 秋
    (2026, 2, 28, "2025秋"),
    (2026, 3, 1, "2026春"),
]


def _ms(year: int, month: int, day: int, *, hour: int = 12) -> int:
    """北京时间某日某点 → 毫秒时间戳（取 12:00，避免贴边界的时区歧义）。"""
    utc = datetime(year, month, day, hour, tzinfo=timezone.utc) - timedelta(hours=8)
    return int(utc.timestamp() * 1000)


@pytest.mark.parametrize("year,month,day,expected", _BOUNDARIES)
def test_term_from_date_boundaries(year, month, day, expected):
    assert term_from_date(year, month) == expected, f"{year}-{month:02d}-{day}"


@pytest.mark.parametrize("year,month,day,expected", _BOUNDARIES)
def test_term_from_ms_uses_beijing_time(year, month, day, expected):
    """从毫秒推学期要按**北京时间**取年月，否则跨时区会错一个月。"""
    assert term_from_ms(_ms(year, month, day)) == expected


def test_term_from_ms_handles_missing_and_bad_input():
    assert term_from_ms(None) is None
    assert term_from_ms(0) is None


def test_term_from_date_rejects_bad_month():
    assert term_from_date(2025, 0) is None
    assert term_from_date(2025, 13) is None


def test_beijing_midnight_month_edge():
    """北京时间 9 月 1 日 00:00 必须算秋 —— 用 UTC 直接取月会掉到 8 月（春）。"""
    local_midnight = int(
        (datetime(2025, 9, 1, 0, 0, tzinfo=timezone.utc) - timedelta(hours=8)).timestamp() * 1000
    )
    assert term_from_ms(local_midnight) == "2025秋"


# ── payload 集成：优先级不能反过来 ──────────────────────────────

_ids = count(1)


def _result(participation: Participation) -> MemberQueryResult:
    merged = merge_members(
        [
            MemberRecord(
                base_key="base_25_26",
                base_token="tok",
                table_id="main",
                record_id=f"rec{next(_ids)}",
                name="张三",
                sid="2300017473",
                raw_fields={},
            )
        ]
    )
    assert merged is not None
    return MemberQueryResult(found=True, member=merged, participations=(participation,))


def _activity(**kw) -> dict:
    base = dict(
        base_key="base_25_26",
        table_id="tbl1",
        activity_name="9月21日宣传部第一次例会",
        group="宣传部",
        term=None,
        record_id="r1",
        event_time_ms=_ms(2025, 9, 21),
        hours=2.0,
    )
    base.update(kw)
    # ⚠️ 不要传 status=：那个参数是给「入参为空 / 链路报错」这类**失败**用的，
    # 一旦传了就会走提前返回，连 member 都不带（我第一次就栽在这）。
    return P.build_payload(_result(Participation(**base)), degraded=False)


def test_payload_derives_term_from_activity_date_when_table_has_none():
    """用户报的那条：表名/文件夹名没有学期 → 用活动日期补成 2025秋。"""
    out = _activity()
    activity = out["member"]["activities"][0]
    assert activity["term"] == "2025秋"


def test_payload_keeps_table_term_and_never_overrides_it():
    """表名给了学期就以它为准 —— 哪怕与日期看起来矛盾（骨干的事实优先）。"""
    out = _activity(term="2026春")
    assert out["member"]["activities"][0]["term"] == "2026春"


def test_payload_falls_back_to_unknown_without_any_date():
    """既没有学期、也没有明确活动日期 → 仍是「未标注学期」，不能编。"""
    out = _activity(event_time_ms=None)
    assert out["member"]["activities"][0]["term"] == P.UNKNOWN_TERM


def test_payload_does_not_use_record_created_time_for_term():
    """只有创建时间（批量导入时刻）时**不**推学期 —— 那会把老活动算进新学年。

    这条是刻意的取舍：创建时间是导入那一刻，不是活动发生的日期。
    同一份记录里 date 字段仍会回退到它（界面要显示一个日期），但 term 不会。
    """
    out = _activity(event_time_ms=None, record_created_ms=_ms(2026, 3, 5))
    activity = out["member"]["activities"][0]
    assert activity["term"] == P.UNKNOWN_TERM
    assert activity["date"] == "2026-03-05"   # 日期照样回退，保证时间轴有序


def test_derived_term_survives_the_frontend_contract_regex():
    """推出来的学期必须能过前端的四位年份正则，否则学年分组会塌。"""
    out = _activity()
    term = out["member"]["activities"][0]["term"]
    assert term == "2025秋"
    assert term[:4].isdigit() and len(term) == 5
