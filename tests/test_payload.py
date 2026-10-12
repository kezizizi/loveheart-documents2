"""表现层适配的回归测试：后端模型 → 前端契约 JSON（``ui/payload.py``）。

守住的是**格式**，不是风格 —— 下面每一条都有明确的坏掉方式：

* ``date`` 不补零 → 前端按字符串排序 → **时间轴顺序全乱**；
* ``term`` 不是「四位年份 + 季节」→ **学年分组整个塌掉**；
* ``hours`` 发成字符串 → 前端 ``toFixed`` 直接抛错；
* 响应里混进敏感字段名 → 越过隐私边界（红线 3.4）；
* 后端顺手把 ``stats`` / ``groups`` 也算一遍 → 与前端各算一套，必然自相矛盾（§2.3②）。
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone

import pytest

from config import SENSITIVE_FIELDS
from feishu.member_query import (
    NOT_FOUND_NAME,
    NOT_FOUND_SID,
    NOT_FOUND_SID_MISSING,
    MemberQueryResult,
    query_member,
)
from feishu.models import MemberRecord, Participation
from feishu.registry import build_registry
from services.identity import merge_members
from ui import payload as P

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TERM_RE = re.compile(r"^(\d{4})(.*)$")


def _ms(year: int, month: int, day: int) -> int:
    """北京时间的某日零点 → 毫秒时间戳。"""
    utc = datetime(year, month, day, tzinfo=timezone.utc) - timedelta(hours=8)
    return int(utc.timestamp() * 1000)


def _participation(**kw) -> Participation:
    base = dict(
        base_key="base_25_26",
        table_id="tblA",
        activity_name="敬老院探访",
        group="护老部",
        term="2023秋",
        record_id="rec1",
        event_time_ms=_ms(2023, 9, 1),
        hours=3.5,
    )
    base.update(kw)
    return Participation(**base)


def _result(
    participations=(),
    *,
    name: str = "张三",
    sid: str = "2300017473",
    fields: dict | None = None,
    created_ms: int | None = None,
    companions: int | None = None,
    found: bool = True,
    reason: str | None = None,
) -> MemberQueryResult:
    member = None
    if found:
        merged = merge_members(
            [
                MemberRecord(
                    base_key="base_25_26",
                    base_token="tok",
                    table_id="main",
                    record_id="recM",
                    name=name,
                    sid=sid,
                    raw_fields=fields or {},
                    created_time_ms=created_ms,
                )
            ]
        )
        assert merged is not None
        member = merged
    return MemberQueryResult(
        found=found,
        member=member,
        participations=tuple(participations),
        not_found_reason=reason,
        co_partners=companions,
    )


# --------------------------------------------------------------------------
# 格式：写错就坏功能的三处
# --------------------------------------------------------------------------


def test_date_is_zero_padded():
    """9 月 1 日必须发成 2023-09-01，不能是 2023-9-1 —— 前端按字符串排序。"""
    p = P.build_payload(_result([_participation(event_time_ms=_ms(2023, 9, 1))]))
    date = p["member"]["activities"][0]["date"]
    assert date == "2023-09-01"
    assert DATE_RE.match(date)


def test_date_falls_back_to_record_created_time():
    """没有参与时间时退到记录创建时间，而不是留空。"""
    p = P.build_payload(
        _result([_participation(event_time_ms=None, record_created_ms=_ms(2024, 3, 7))])
    )
    assert p["member"]["activities"][0]["date"] == "2024-03-07"


def test_term_is_four_digit_year_plus_season():
    p = P.build_payload(_result([_participation(term="2025秋")]))
    term = p["member"]["activities"][0]["term"]
    m = TERM_RE.match(term)
    assert m and m.group(1) == "2025", f"term 必须是四位年份 + 季节，实际 {term!r}"


def test_term_fallback_is_still_a_string_and_does_not_fake_a_year():
    """学期缺失时给占位词，**不能**编一个四位年份出来（那会凭空造出一个学年）。"""
    p = P.build_payload(_result([_participation(term=None)]))
    term = p["member"]["activities"][0]["term"]
    assert term == P.UNKNOWN_TERM
    assert not TERM_RE.match(term), "占位词不能被当年份解析"


def test_hours_is_a_number_not_a_string():
    p = P.build_payload(_result([_participation(hours=2)]))
    hours = p["member"]["activities"][0]["hours"]
    assert isinstance(hours, float)
    assert hours == 2.0


# --------------------------------------------------------------------------
# 隐私：红线 3.4
# --------------------------------------------------------------------------


def test_payload_never_contains_sensitive_field_names():
    fields = {"姓名": "张三", "院系": "元培学院"}
    fields.update({name: "不该出现" for name in SENSITIVE_FIELDS})
    p = P.build_payload(_result([_participation()], fields=fields))
    blob = json.dumps(p, ensure_ascii=False)
    for name in SENSITIVE_FIELDS:
        assert name not in blob, f"敏感字段 {name} 泄漏进了响应"


# --------------------------------------------------------------------------
# 成员字段
# --------------------------------------------------------------------------


@pytest.mark.parametrize("column", ["想对爱心社说的话", "想说的话"])
def test_join_message_reads_both_column_names(column):
    """两个库的列名不同：26-27 叫「想对爱心社说的话」，25-26 叫「想说的话」。"""
    fields = {column: [{"text": "希望做的小事都还站在某个人身边。"}]}
    p = P.build_payload(_result(fields=fields))
    assert p["member"]["joinMessage"] == "希望做的小事都还站在某个人身边。"


def test_join_message_missing_is_empty_string_not_fabricated():
    p = P.build_payload(_result(fields={"姓名": "张三"}))
    assert p["member"]["joinMessage"] == ""


def test_join_date_source_filled_when_field_present():
    fields = {"入社日期": _ms(2023, 9, 16)}
    p = P.build_payload(_result(fields=fields))
    assert p["member"]["joinDate"] == "2023-09-16"
    assert p["member"]["joinDateSource"] == "filled"


def test_join_date_source_created_when_falling_back():
    p = P.build_payload(_result(fields={}, created_ms=_ms(2024, 5, 18)))
    assert p["member"]["joinDate"] == "2024-05-18"
    assert p["member"]["joinDateSource"] == "created"


def test_join_date_missing_is_none_and_source_none():
    """两样都没有 → null；前端显示「—」，而且不会挂一句不实的说明。"""
    p = P.build_payload(_result(fields={}, created_ms=None))
    assert p["member"]["joinDate"] is None
    assert p["member"]["joinDateSource"] == "none"


def test_college_missing_is_empty_string():
    p = P.build_payload(_result(fields={"姓名": "张三"}))
    assert p["member"]["college"] == ""


def test_companions_none_is_not_zero():
    """统计不到必须是 None：0 会谎称「一个同场伙伴都没有」。"""
    assert P.build_payload(_result(companions=None))["member"]["companions"] is None
    assert P.build_payload(_result(companions=0))["member"]["companions"] == 0


def test_unknown_group_falls_back_to_other_label():
    from config import UNKNOWN_GROUP_LABEL

    p = P.build_payload(_result([_participation(group=None)]))
    assert p["member"]["activities"][0]["group"] == UNKNOWN_GROUP_LABEL


def test_note_uses_reflection_not_content():
    """实心圆点的语义是「这一场留下了你的**感想**」。
    把活动描述（content）塞进 note 等于替社员编造语气，所以只取 reflection。"""
    with_reflection = P.build_payload(
        _result([_participation(reflection="教张奶奶存了第一个联系人。")])
    )
    assert with_reflection["member"]["activities"][0]["note"] == "教张奶奶存了第一个联系人。"

    only_content = P.build_payload(
        _result([_participation(reflection="", content="讲解智能手机基础操作")])
    )
    assert only_content["member"]["activities"][0]["note"] == ""


# --------------------------------------------------------------------------
# status
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("reason", "expected"),
    [
        (NOT_FOUND_NAME, P.STATUS_NOT_FOUND_NAME),
        (NOT_FOUND_SID, P.STATUS_NOT_FOUND_SID),
        (NOT_FOUND_SID_MISSING, P.STATUS_NOT_FOUND_SID_MISSING),
    ],
)
def test_not_found_reasons_map_to_frontend_status(reason, expected):
    p = P.build_payload(_result(found=False, reason=reason))
    assert p == {"status": expected}


def test_reason_none_becomes_error_not_not_found_name():
    """检索一次都没成功过 → 不能伪装成「查无此人」，那会把人引向补录问卷。"""
    p = P.build_payload(_result(found=False, reason=None))
    assert p == {"status": P.STATUS_ERROR}


def test_invalid_input_status():
    assert P.payload_for_invalid_input() == {"status": P.STATUS_INVALID_INPUT}


# --------------------------------------------------------------------------
# 契约：后端不发派生字段
# --------------------------------------------------------------------------


def test_payload_does_not_contain_derived_fields():
    """派生（stats/groups/terms/years）是前端的活。

    后端一旦也发一份，两边就会各算各的 —— 历史上正是这样出现过
    「身份栏写着 9 个部组、下面每个活动却都是『其他』」。"""
    p = P.build_payload(_result([_participation()]))
    for key in ("stats", "groups", "terms", "years"):
        assert key not in p, f"{key} 应该由前端派生，后端不要发"
        assert key not in p["member"]


# --------------------------------------------------------------------------
# 用真实 fixture 走一遍端到端
# --------------------------------------------------------------------------


def test_payload_from_real_fixture_shape(specs, fixture_client_with_records):
    client = fixture_client_with_records
    registry = build_registry(client, specs)
    result = query_member(client, registry, specs, "张三", "2300017473")
    assert result.found

    p = P.build_payload(result)
    assert p["status"] == P.STATUS_OK
    assert p["degraded"] is False
    member = p["member"]
    assert member["name"] == "张三"
    assert member["sid"] == "2300017473"
    assert member["activities"], "fixture 里张三应当有参与记录"

    for a in member["activities"]:
        if a["date"] is not None:
            assert DATE_RE.match(a["date"]), a
        assert isinstance(a["hours"], (int, float))
        assert isinstance(a["term"], str)
        assert isinstance(a["group"], str)

    blob = json.dumps(p, ensure_ascii=False)
    for name in SENSITIVE_FIELDS:
        assert name not in blob
