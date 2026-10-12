"""单成员跨库查询。

只认已建立的双向关联
--------------------
主表里「这个人参加过哪几场活动」的关联列，是活动记录的**唯一**来源：
主表里没有关联的活动，一律不查。

这条规则取代了早期的「扫表兜底」（那时若关联列全空，就逐表按姓名扫一遍）。
现在不做任何姓名匹配，因此：

* 一条活动记录要么因为被关联而出现，要么根本不出现；
* 命中即高置信（``confidence`` 恒为 ``high``），不存在「待确认」；
* 请求量降到最低 —— **只对真的有关联的那几张表发请求，其余 0 请求**。

代价是活动记录必须都已建立关联，否则那条记录对该社员不可见。

成员匹配规则（不可放宽）
------------------------
在主表里认人时，**姓名和学号必须同时命中**，只看姓名一律不算本人；
查不到时按 :data:`NOT_FOUND_*` 归因，交给 UI 给出对应的补录引导。
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from typing import Any, Iterable, Sequence

from config import CO_PARTNER_CAP, MEMBER_READ_WHITELIST
from feishu import schema as S
from feishu.client import SchemaChangedError
from feishu.models import (
    ActivityRegistry,
    ActivityTable,
    MemberRecord,
    Participation,
)
from feishu.protocol import BitableClient
from services.identity import (
    MergedMember,
    merge_members,
    names_equal,
    normalize_name,
    normalize_sid,
    sids_equal,
)

# 从活动记录里挑「正文」用的字段关键词
_CONTENT_HINTS = ("核心内容", "活动内容", "环节", "印象深刻", "收获", "学习", "建议")
_REFLECTION_HINTS = ("感想", "想说的话", "收获", "体会")
_MAX_CONTENT_LEN = 160

# ⚠️ 改成「只认关联」之后，参与记录**必然**来自主表里已建立的那条关联，
# 因此 confidence 恒为 CONFIDENCE_HIGH，另两档在查询层已经用不到了。
# 之所以还没删：`confidence` 会出现在 CSV 导出的「置信度」列和 UI 的标签上，
# 那是**给人看的输出**，要不要连列一起撤掉得单独决定。
# 在此之前，MEDIUM / LOW 只是历史遗留，新代码不要再去判它们。
CONFIDENCE_HIGH = "high"
CONFIDENCE_MEDIUM = "medium"
CONFIDENCE_LOW = "low"

# 查不到的原因。每一种对应 UI 上一句不同的话，都要引导去补录问卷。
NOT_FOUND_NAME = "name"                # 档案里根本没有这个姓名
NOT_FOUND_SID = "sid"                  # 姓名在档案里，但配的学号对不上
NOT_FOUND_SID_MISSING = "sid_missing"  # 姓名在档案里，但那条档案没填学号

# 归因优先级：越靠前越「可行动」。「档案里缺学号」能靠补录直接解决，
# 所以即使别的库只是「查不到姓名」，也优先报它。
_REASON_PRIORITY = (NOT_FOUND_SID_MISSING, NOT_FOUND_SID, NOT_FOUND_NAME)


def pick_not_found_reason(reasons: Sequence[str | None]) -> str | None:
    """把各库的归因收敛成一个：按可行动程度取最优。

    一个归因都拿不到时（例如每个库的检索都报错了、压根没查成）返回 ``None``。
    这种情况下「姓名查不到」是我们编出来的，不如老实说不知道，
    让 UI 回退到通用提示。
    """
    observed = {r for r in reasons if r}
    for candidate in _REASON_PRIORITY:
        if candidate in observed:
            return candidate
    return None


@dataclass(frozen=True)
class MemberLookup:
    """某个库内的查找结果。

    ``reason`` 只有在 ``records`` 为空**且确实查过**时才有值；
    一次都没查成时它是 ``None``（此时 ``errors`` 说明原因）——
    绝不能把「查不成」伪装成「查无此人」，那会把人引向补录问卷，
    而真正的问题出在系统这一侧。
    """

    records: tuple[MemberRecord, ...] = ()
    reason: str | None = None
    errors: tuple[str, ...] = ()


@dataclass(frozen=True)
class MemberQueryResult:
    found: bool
    member: MergedMember | None
    participations: tuple[Participation, ...]
    errors: tuple[str, ...] = ()
    searched_bases: tuple[str, ...] = ()
    #: 仅在 ``found is False`` 时有值，取值见 ``NOT_FOUND_*``
    not_found_reason: str | None = None
    #: **主表根本没读到**的库标签（权限 / 限流 / 网络）。非空表示这次结果**不完整**：
    #: 缺的不是某一张活动表，而是整个库的档案与它的关联 —— 可能少一整学年，
    #: 也可能表现成「档案找到了，但一场活动都没有」。
    #: **必须**与「真的没建关联」区分开，否则会把系统故障说成「你的数据没补全」，
    #: 让社员白跑去找骨干（红线 3.16）。
    bases_unread: tuple[str, ...] = ()
    #: 「与 N 位伙伴同行」的人数。``None`` = 统计不到（一张表都扫不动），
    #: 与 0（真的一个同场伙伴都没有）**必须区分** —— 0 会谎称「没有伙伴」。
    co_partners: int | None = None
    #: 参与过的活动表超过 ``CO_PARTNER_CAP`` 时为 True —— 此时人数是**下界**
    co_partners_truncated: bool = False

    @property
    def low_confidence_count(self) -> int:
        return sum(1 for p in self.participations if p.confidence == CONFIDENCE_LOW)


@dataclass(frozen=True)
class CollectedRecords:
    """一次采集的完整产物：参与记录 + 失败信息 + 同行伙伴姓名集合。"""

    participations: tuple[Participation, ...] = ()
    errors: tuple[str, ...] = ()
    #: 归一化后的同场伙伴姓名（**只在内存里用来数人头，绝不外传**）
    partner_names: frozenset[str] = frozenset()
    #: 实际扫成功的活动表张数。为 0 表示「统计不到」，而不是「没有伙伴」。
    tables_scanned: int = 0
    partners_truncated: bool = False


# --------------------------------------------------------------------------
# 字段投影
# --------------------------------------------------------------------------


def _requestable(names: Iterable[str]) -> set[str]:
    """只留下名字短到能进请求投影的字段。

    超长字段名会让飞书拒掉**整个主表查询** —— 那时候一个人都找不到，
    比少读一列严重得多。
    """
    return {n for n in names if n and S.is_requestable_field_name(n)}


def main_projection(registry: ActivityRegistry, spec: Any) -> list[str] | None:
    """主表最小字段投影：白名单 ∩ 实际存在 ∪ 活动 link 字段名。"""
    existing = set(registry.main_field_names(spec.key))
    link_names = _requestable(
        t.main_link_field for t in registry.tables_of(spec.key) if t.main_link_field
    )
    if not existing:
        # 主表字段没读到：退回白名单（不含任何活动 link 名），
        # 至少保证匹配所需的姓名 / 学号在投影里。
        return sorted(_requestable(set(MEMBER_READ_WHITELIST) | link_names))

    allowed = _requestable(n for n in MEMBER_READ_WHITELIST if n in existing)
    return sorted(allowed | link_names)


def _find_key(fields: dict[str, Any], needle: str) -> str | None:
    for key in fields:
        if needle in key:
            return key
    return None


def _row_identity(fields: dict[str, Any]) -> tuple[str, str]:
    """取出一行的（姓名, 学号）原文。

    真实表里这两个字段可能带前缀（26-27 活动表里叫「您的学号」），
    所以先按精确名取，取不到再按子串找。
    """
    name = S.cell_text(fields.get("姓名")) or S.cell_text(
        fields.get(_find_key(fields, "姓名") or "")
    )
    sid = S.cell_text(fields.get("学号")) or S.cell_text(
        fields.get(_find_key(fields, "学号") or "")
    )
    return name, sid


# --------------------------------------------------------------------------
# 找主表记录
# --------------------------------------------------------------------------


def _rows_to_members(
    rows: Sequence[dict[str, Any]],
    spec: Any,
    link_names: set[str],
    name: str,
    sid: str,
) -> list[MemberRecord]:
    out: list[MemberRecord] = []
    for row in rows:
        fields = row.get("fields") or {}
        row_name, row_sid = _row_identity(fields)
        if not names_equal(row_name, name):
            continue
        if not sids_equal(row_sid, sid):
            continue

        link_targets: dict[str, tuple[str, ...]] = {}
        for key, value in fields.items():
            if key in link_names:
                ids = S.cell_link_record_ids(value)
                if ids:
                    link_targets[key] = tuple(ids)

        out.append(
            MemberRecord(
                base_key=spec.key,
                base_token=spec.base_token,
                table_id=spec.main_table_id,
                record_id=row.get("record_id") or "",
                name=normalize_name(row_name),
                sid=normalize_sid(row_sid),
                raw_fields=dict(fields),
                created_time_ms=row.get("created_time_ms"),
                link_targets=link_targets,
            )
        )
    return out


def lookup_member(
    client: BitableClient,
    spec: Any,
    registry: ActivityRegistry,
    name: str,
    sid: str,
) -> MemberLookup:
    """在某一个库里找出该人的主表记录（可能多条），并归因查不到的原因。

    **姓名与学号必须同时命中**才算本人，只看姓名一律不算。

    诊断复用本次两次检索的结果，**不额外发请求** —— 飞书 API 有月度配额，
    查不到时再多打几枪是拿配额换一句提示语，不划算。
    """
    projection = main_projection(registry, spec)
    link_names = {
        t.main_link_field
        for t in registry.tables_of(spec.key)
        if t.main_link_field
    }

    # (检索关键词, 检索字段, 这一趟是不是「按姓名」)
    attempts: list[tuple[str, list[str], bool]] = [
        (name, ["姓名"], True),
        # 兜底：万一姓名有异体字 / 关键词语义检索不中，再用学号搜一次
        (str(normalize_sid(sid)), ["学号"], False),
    ]

    saw_name = False
    saw_name_without_sid = False
    # 检索本身有没有成功过。一次都没成功就不能做归因。
    searched = False
    search_errors: list[str] = []

    for keyword, search_fields, by_name in attempts:
        if not keyword:
            continue
        try:
            rows = client.search_records(
                spec.base_token,
                spec.main_table_id,
                field_names=projection,
                keyword=keyword,
                search_fields=search_fields,
                automatic_fields=True,
            )
        except SchemaChangedError:
            # 表结构变了：必须让上层知道（要重建注册表再试），
            # 绝不能当成「这条兜底路径失败」吞掉。
            raise
        except Exception as exc:  # noqa: BLE001 - 单条兜底路径失败不算致命
            search_errors.append(f"[{spec.label}] 检索主表失败：{exc}")
            continue
        searched = True

        matched = _rows_to_members(rows, spec, link_names, name, sid)
        if matched:
            return MemberLookup(records=tuple(matched))

        if not by_name:
            continue
        for row in rows:
            row_name, row_sid = _row_identity(row.get("fields") or {})
            if not names_equal(row_name, name):
                continue
            saw_name = True
            if not normalize_sid(row_sid):
                saw_name_without_sid = True

    failures = tuple(search_errors)
    if not searched:
        return MemberLookup(records=(), reason=None, errors=failures)

    if saw_name_without_sid:
        # 姓名对上了，但那一条档案没有学号 —— 只能靠补录解决
        reason = NOT_FOUND_SID_MISSING
    elif saw_name:
        reason = NOT_FOUND_SID
    else:
        reason = NOT_FOUND_NAME
    return MemberLookup(records=(), reason=reason, errors=failures)


# --------------------------------------------------------------------------
# 采集参与记录
# --------------------------------------------------------------------------


def _pick_hours(table: ActivityTable, fields: dict[str, Any]) -> tuple[float, str]:
    total = 0.0
    raws: list[str] = []
    for field_name in table.hours_fields:
        value = fields.get(field_name)
        number = S.cell_number(value)
        if number is None:
            continue
        total += number
        text = S.cell_text(value)
        if text:
            raws.append(text)
    return total, " + ".join(raws)


def _pick_event_time(table: ActivityTable, fields: dict[str, Any]) -> int | None:
    for field_name in table.time_fields:
        ts = S.cell_datetime_ms(fields.get(field_name))
        if ts:
            return ts
    return None


def _pick_text(
    fields: dict[str, Any],
    hints: Sequence[str],
    *,
    limit: int | None = None,
) -> str:
    for hint in hints:
        key = _find_key(fields, hint)
        if not key:
            continue
        text = S.cell_text(fields.get(key))
        if text:
            return text[:limit] if limit else text
    return ""


def build_participation(
    table: ActivityTable,
    row: dict[str, Any],
    confidence: str,
) -> Participation:
    fields = row.get("fields") or {}
    hours, hours_raw = _pick_hours(table, fields)
    return Participation(
        base_key=table.base_key,
        table_id=table.table_id,
        activity_name=table.name,
        group=table.group,
        term=table.term,
        record_id=row.get("record_id") or "",
        event_time_ms=_pick_event_time(table, fields),
        record_created_ms=row.get("created_time_ms"),
        hours=hours,
        hours_raw=hours_raw,
        reflection=_pick_text(fields, _REFLECTION_HINTS),
        content=_pick_text(fields, _CONTENT_HINTS, limit=_MAX_CONTENT_LEN),
        confidence=confidence,
    )


def _fetch_linked(
    client: BitableClient, table: ActivityTable, record_ids: Sequence[str]
) -> list[Participation]:
    """按主表关联列给出的 record_id 精确取数。

    拿到的一定是本人记录，因此置信度恒为 ``high`` —— 这条路没有「可能是同名」的问题。
    """
    rows = client.batch_get_records(
        table.base_token,
        table.table_id,
        list(record_ids),
        field_names=list(table.safe_fields),
    )
    return [build_participation(table, row, CONFIDENCE_HIGH) for row in rows]


def linked_tables(
    registry: ActivityRegistry, member: MergedMember
) -> list[tuple[ActivityTable, tuple[str, ...]]]:
    """挑出「主表里**确实关联了**记录」的表，连同那些 record_id。

    这是整条查询**唯一**的取数范围。没有关联的活动一律不查 ——
    不做姓名兜底扫描，所以请求量等于「真有参与记录的表数」，其余表 0 请求。
    """
    out: list[tuple[ActivityTable, tuple[str, ...]]] = []
    for key in member.base_keys:
        for table in registry.tables_of(key):
            if not table.main_link_field:
                continue
            ids = member.link_targets_of(table.base_key, table.main_link_field)
            if ids:
                out.append((table, ids))
    return out


def scan_table_names(client: BitableClient, table: ActivityTable) -> set[str] | None:
    """扫一张活动表的「姓名」列，返回归一化后的姓名集合。

    只投影**姓名一列**：这是「与谁同行」唯一需要的东西，也把读到的个人信息压到最小
    （绝不顺带把别人的感想、正文拉进内存）。

    返回值刻意三态：
    * ``None`` —— 这张表扫不动（没有姓名列，或请求失败）；
    * ``set()`` —— 扫到了，但一张报名记录都没有；
    * 非空集合 —— 姓名集合。

    上层要靠 ``None`` 与空集的差别来区分「统计不到」和「真的没有伙伴」。
    """
    name_field = table.name_field
    if not name_field:
        return None
    try:
        rows = client.search_records(
            table.base_token, table.table_id, field_names=[name_field]
        )
    except SchemaChangedError:
        # 结构变更不是「这张表读不到」，而是整份注册表都过时了，必须穿透（见 CLAUDE.md §9）
        raise
    except Exception:  # noqa: BLE001 - 单表失败不影响其他表
        return None

    names: set[str] = set()
    for row in rows:
        text = S.cell_text((row.get("fields") or {}).get(name_field))
        normalized = text.replace(" ", "")
        if normalized:
            names.add(normalized)
    return names


def _fetch_table(
    client: BitableClient,
    table: ActivityTable,
    record_ids: tuple[str, ...],
    *,
    with_partners: bool,
) -> tuple[list[Participation], int, set[str]]:
    """一张表的全部工作，跑在线程池里的那个任务。

    顺序执行 **两次** 请求：先按关联 record_id 取本人记录，再扫本表姓名列。
    两次都落在同一张表、同一个任务里，所以并发度不损失 —— 墙钟时间约等于
    「单张表两次串行请求」，而不是「所有表各扫一遍」。
    """
    participations = _fetch_linked(client, table, record_ids)
    if not with_partners:
        return participations, 0, set()
    names = scan_table_names(client, table)
    if names is None:
        return participations, 0, set()
    return participations, 1, names


def collect_records(
    client: BitableClient,
    registry: ActivityRegistry,
    member: MergedMember,
    *,
    max_workers: int = 8,
    with_partners: bool = False,
    partner_cap: int = CO_PARTNER_CAP,
) -> CollectedRecords:
    """并发采集该人的活动参与记录（可选：顺带数出同行伙伴）。

    范围由 :func:`linked_tables` 决定：**只查主表里有该人关联记录的那几张表**，
    其余一张都不碰（连空表都不用问）。没有关联就是没有参与记录。

    🚩 这条范围是红线：活动表访问是整条链路里最贵的一步，而飞书 API 调用量
    有月度上限。历史上出现过「顺手改成扫全部库」的想法，理由是「多扫一点结果更全」
    —— 那不是优化，是把配额烧光。
    ``tests/test_member_query.py::test_collect_participations_never_widens_scope``
    是守卫测试。

    ``with_partners=True`` 时对**同一批**表额外扫一次姓名列（每表 +1 次请求），
    上限 ``partner_cap`` 张；超出则 ``partners_truncated`` 置位，人数是下界。
    因为共用同一个线程池，这一项不会让墙钟时间翻倍。
    """
    targets = linked_tables(registry, member)
    if not targets:
        return CollectedRecords()

    truncated = with_partners and len(targets) > partner_cap
    if with_partners and truncated:
        targets = targets[:partner_cap]

    participations: list[Participation] = []
    errors: list[str] = []
    partner_names: set[str] = set()
    scanned = 0

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {
            pool.submit(
                _fetch_table, client, table, ids, with_partners=with_partners
            ): table
            for table, ids in targets
        }
        for future in as_completed(futures):
            table = futures[future]
            try:
                rows, hit, names = future.result()
            except SchemaChangedError:
                # 结构变更不是「这一张表读不到」，而是整份注册表都过时了。
                # 必须穿透隔离抛上去，让上层重建注册表后重试。
                raise
            except Exception as exc:  # noqa: BLE001 - 单表失败隔离
                errors.append(f"读取活动「{table.name}」失败：{exc}")
                continue
            participations.extend(rows)
            scanned += hit
            partner_names |= names

    participations.sort(
        key=lambda p: (p.event_time_ms or p.record_created_ms or 0, p.activity_name)
    )
    return CollectedRecords(
        participations=tuple(participations),
        errors=tuple(errors),
        partner_names=frozenset(partner_names),
        tables_scanned=scanned,
        partners_truncated=truncated,
    )


def collect_participations(
    client: BitableClient,
    registry: ActivityRegistry,
    member: MergedMember,
    *,
    max_workers: int = 8,
) -> tuple[list[Participation], list[str]]:
    """只要参与记录（不数同行伙伴）。保持原有的二元返回值。"""
    got = collect_records(client, registry, member, max_workers=max_workers)
    return list(got.participations), list(got.errors)


# --------------------------------------------------------------------------
# 对外入口
# --------------------------------------------------------------------------


def query_member(
    client: BitableClient,
    registry: ActivityRegistry,
    specs: Sequence[Any],
    name: str,
    sid: str,
    *,
    max_workers: int = 8,
    want_partners: bool = False,
) -> MemberQueryResult:
    """按姓名 + 学号查询一个人的完整爱心足迹。

    ``want_partners=True`` 时**顺带**数出「与 N 位伙伴同行」。它不是白拿的：
    要对同一批活动表各多发一次「只取姓名列」的请求（每表 +1，上限
    ``CO_PARTNER_CAP`` 张），但和取数共用同一个线程池，墙钟时间几乎不变。
    新前端的身份栏默认就要显示这个数字，所以由调用方按需开启。
    """
    records: list[MemberRecord] = []
    # 注册表构建期的失败（某库 403、某张表读不到）必须一并透出，
    # 否则用户会以为「没参加过」，而实际是「没查到」。
    errors: list[str] = list(registry.errors)
    searched: list[str] = []

    reasons: list[str | None] = []
    #: 主表**一次都没读到**的库。它决定这次结果完不完整 —— 见 MemberQueryResult.bases_unread
    unread: list[str] = []
    for spec in specs:
        searched.append(spec.key)
        try:
            look = lookup_member(client, spec, registry, name, sid)
        except SchemaChangedError:
            raise
        except Exception as exc:  # noqa: BLE001
            errors.append(f"查询 {spec.label} 主表失败：{exc}")
            unread.append(spec.label)
            continue
        reasons.append(look.reason)
        records.extend(look.records)
        errors.extend(look.errors)
        # 这个库**一次都没给出答案**（它自己每一趟检索都失败了）→ 也算「没读到」。
        # 注意它通常**不抛异常**：lookup_member 把每趟检索的失败都收进 errors，
        # 只有「所有检索都失败」时才留下 reason=None 这个信号（见 pick_not_found_reason）。
        # 光看异常会把这一整类漏掉 —— 那正是用户看到的「档案找到了却一场活动都没有」。
        if not look.records and look.reason is None:
            unread.append(spec.label)
        # 这个库的**主表字段没读到** → 它的关联列进不了主表投影 → 这个库的参与记录
        # 一场都取不到，而 lookup 完全成功（人找得到、也不会报错）。
        # 不在这里标出来的话，用户会看到「你没有关联活动」——把系统故障说成他没补数据。
        if registry.is_link_blind(spec.key):
            unread.append(spec.label)

    if not records:
        # ⚠️ 有库没读到的时候，「查无此人」这个结论是**不成立**的：
        # 那个人完全可能就在没读到的那个库里。拿另一个库的归因当结论，
        # 会把社员引向补录问卷 —— 与红线 3.12 同一类错误，只是方向相反。
        # 所以这时只能说「没查成」（归因 None），交给上层重试 / 如实报错。
        return MemberQueryResult(
            found=False,
            member=None,
            participations=(),
            errors=tuple(errors),
            searched_bases=tuple(searched),
            not_found_reason=None if unread else pick_not_found_reason(reasons),
            bases_unread=tuple(unread),
        )

    member = merge_members(records)
    assert member is not None  # records 非空

    got = collect_records(
        client,
        registry,
        member,
        max_workers=max_workers,
        with_partners=want_partners,
    )
    errors.extend(got.errors)

    # 只出人数、不出姓名；一张表都扫不动时给 None（视图显示「—」），绝不退回 0
    co_partners: int | None = None
    if want_partners:
        others = set(got.partner_names)
        others.discard(member.name.replace(" ", ""))
        co_partners = len(others) if got.tables_scanned else None

    return MemberQueryResult(
        found=True,
        member=member,
        participations=got.participations,
        errors=tuple(errors),
        searched_bases=tuple(searched),
        co_partners=co_partners,
        co_partners_truncated=got.partners_truncated,
        bases_unread=tuple(unread),
    )
