"""「没查成」与「查无此人」的分界（``ui/embed.py``）。

背景：用户报过一次「这次没能读到你的档案」——那是 ``status: ERROR``，一个死胡同。
排查时发现底层查询是好的（10 个真实社员全部 OK），但有三处**可证的缺陷**会让
任何一次瞬时失败（限流 / 网络抖动 / 权限）都变成同样的死胡同，而且**事后无法定位**：

1. ``build_payload`` 原先在 ``try`` 外面 —— 翻译层自己的 bug 会把整页打成「启动失败」；
2. ``status: ERROR`` 不携带任何诊断信息，底层那些错误原文被丢掉了；
3. 「没查成」被当成**结果**返回，于是被 ``st.cache_data`` 缓存住 10 分钟 ——
   用户「再试一次」拿到的还是同一个失败，症状就是「一直这样」。

这个文件守住修复后的三条不变量。
"""

from __future__ import annotations

import pytest

from feishu.member_query import NOT_FOUND_NAME, MemberQueryResult, Participation
from feishu.models import MemberRecord
from services.identity import merge_members
from ui import embed, payload


def _unavailable(*errors: str) -> MemberQueryResult:
    """「每个库的检索都失败了」→ found=False 且归因 None。"""
    return MemberQueryResult(
        found=False, member=None, participations=(), errors=tuple(errors)
    )


def _found() -> MemberQueryResult:
    return MemberQueryResult(found=True, member=None, participations=())


# --------------------------------------------------------------------------
# 判据本身
# --------------------------------------------------------------------------


def test_unavailable_means_found_false_without_a_reason():
    assert embed.is_unavailable(_unavailable("检索失败")) is True


def test_a_real_not_found_is_not_unavailable():
    """「查无此人」是一个确定的答案，不许被当成取数失败。"""
    result = MemberQueryResult(
        found=False, member=None, participations=(), not_found_reason=NOT_FOUND_NAME
    )
    assert embed.is_unavailable(result) is False


def test_found_member_is_not_unavailable():
    assert embed.is_unavailable(_found()) is False


def test_not_found_reason_none_is_the_only_way_to_get_unavailable():
    """归因优先级收敛后：只要**有一个库**给出了归因，就不算取数失败。"""
    for reason in ("name", "sid", "sid_missing"):
        result = MemberQueryResult(
            found=False, member=None, participations=(), not_found_reason=reason
        )
        assert embed.is_unavailable(result) is False, reason


# --------------------------------------------------------------------------
# 重试策略
# --------------------------------------------------------------------------


def test_retries_once_then_succeeds():
    """瞬时失败重试一次就好了 —— 这是限流/抖动的典型形态。"""
    seq = [_unavailable("99991400 限流"), _found()]
    slept: list[float] = []

    result = embed.query_with_retry(
        lambda: seq.pop(0), delay=0.01, sleep=slept.append
    )

    assert result.found is True
    assert slept == [0.01], "应当正好等了 1 次再重试"


def test_raises_when_both_attempts_fail():
    seq = [_unavailable("第一次"), _unavailable("第二次")]
    slept: list[float] = []

    with pytest.raises(embed.QueryUnavailable) as excinfo:
        embed.query_with_retry(lambda: seq.pop(0), delay=0.01, sleep=slept.append)

    assert slept == [0.01]
    assert "第二次" in str(excinfo.value), "异常里必须带上底层错误原文，否则日志无法定位"


def test_does_not_retry_a_real_not_found():
    """「查无此人」不许重试：那是白烧 API 配额。"""
    calls: list[int] = []

    def once() -> MemberQueryResult:
        calls.append(1)
        return MemberQueryResult(
            found=False, member=None, participations=(), not_found_reason=NOT_FOUND_NAME
        )

    result = embed.query_with_retry(once, delay=0.01, sleep=lambda _s: None)

    assert result.not_found_reason == NOT_FOUND_NAME
    assert len(calls) == 1, "只该查一次"


def test_success_is_not_retried():
    calls: list[int] = []

    def once() -> MemberQueryResult:
        calls.append(1)
        return _found()

    embed.query_with_retry(once, delay=0.01, sleep=lambda _s: None)
    assert len(calls) == 1


def test_unavailable_message_falls_back_when_there_are_no_errors():
    with pytest.raises(embed.QueryUnavailable) as excinfo:
        embed.query_with_retry(
            lambda: _unavailable(), delay=0.0, sleep=lambda _s: None
        )
    assert str(excinfo.value), "异常信息不能是空的"


# --------------------------------------------------------------------------
# 缓存：失败的**不许**被冻住
# --------------------------------------------------------------------------


def test_run_query_raises_so_the_failure_is_never_cached(monkeypatch):
    """🚩 这条是「一直这样」的根因守卫。

    ``st.cache_data`` 只缓存**返回值**，抛异常的结果不缓存。所以「没查成」必须抛，
    不能返回 —— 否则 10 分钟内用户重试多少次都是同一个失败。
    判据：两次调用应当各自真的跑满 2 次（各重试 1 次）= 4 次；
    若失败被缓存住，第二次调用会直接抛、不再执行，调用数就只有 2。
    """
    monkeypatch.setattr(embed, "RETRY_DELAY_SECONDS", 0.0)
    calls: list[str] = []

    def fake_once(name: str, sid: str) -> MemberQueryResult:
        calls.append(name)
        return _unavailable("模拟：检索失败")

    monkeypatch.setattr(embed, "_query_once", fake_once)
    embed.run_query.clear()

    for _ in range(2):
        with pytest.raises(embed.QueryUnavailable):
            embed.run_query("张三", "2300017473")

    assert len(calls) == 4, f"失败被缓存住了（只跑了 {len(calls)} 次，应为 4 次）"


# --------------------------------------------------------------------------
# 页面级兜底：翻译层自己的 bug 不许把整页打挂
# --------------------------------------------------------------------------


def test_adapter_bug_becomes_a_status_instead_of_a_crash(monkeypatch):
    """``build_payload`` 必须包在 ``try`` 里。

    它是我们自己的翻译代码，真出 bug 时用户该看到的是一条正常提示，
    完整栈进服务端日志 —— 而不是 Streamlit 的「启动失败」。
    """
    monkeypatch.setenv("AX_DEMO", "1")
    for cached in (embed.get_settings, embed.get_client, embed.load_registry, embed.run_query):
        cached.clear()

    def boom(*_args, **_kwargs):
        raise RuntimeError("模拟：翻译层 bug")

    monkeypatch.setattr(payload, "build_payload", boom)

    result = embed.query_payload("张三", "2300017473")

    assert result == {"status": payload.STATUS_ERROR}


def test_invalid_input_short_circuits_without_querying(monkeypatch):
    called: list[int] = []
    monkeypatch.setattr(embed, "run_query", lambda *a, **k: called.append(1))

    assert embed.query_payload("", "2300017473") == {"status": payload.STATUS_INVALID_INPUT}
    assert embed.query_payload("张三", "   ") == {"status": payload.STATUS_INVALID_INPUT}
    assert called == [], "入参不完整时不该发任何查询"


def test_query_unavailable_maps_to_error_status(monkeypatch):
    def explode(*_args, **_kwargs):
        raise embed.QueryUnavailable("模拟：限流")

    monkeypatch.setattr(embed, "run_query", explode)
    assert embed.query_payload("张三", "2300017473") == {"status": payload.STATUS_ERROR}


# --------------------------------------------------------------------------
# 「没读全」不是「没有活动」（红线 3.16）
# --------------------------------------------------------------------------
#
# 用户真实报过一次：查自己的档案，得到「档案找到了，还没有关联到活动 ——
# 请联系骨干补上关联」。而他那份档案其实有 14 场活动。
# 机制：某个库的**主表**没读到（限流 / 权限 / 网络），而另一个库的档案又还没建关联，
# 于是 found=True + 0 场活动 —— 前端只能看见「0 场」，就把系统故障说成了
# 「你的数据没补全」，让人白跑去找骨干。
#
# 下面守住修复后的三条：判据、重试、以及**不许被缓存**。


def _member():
    """一份可用的 member —— build_payload 在 found=True 时要求它非空。"""
    merged = merge_members(
        [
            MemberRecord(
                base_key="base_25_26",
                base_token="tok",
                table_id="main",
                record_id="r1",
                name="高梓凯",
                sid="2300017473",
                raw_fields={},
            )
        ]
    )
    assert merged is not None
    return merged


def _incomplete(*bases: str, activities: int = 0) -> MemberQueryResult:
    """主表有库没读到 → found=True（另一个库命中了）但结果不完整。"""
    return MemberQueryResult(
        found=True,
        member=_member(),
        participations=tuple(range(activities)),  # 这里只关心条数
        errors=("查询 25-26 学年 主表失败：模拟：限流",),
        searched_bases=("base_25_26", "base_26_27"),
        bases_unread=tuple(bases or ("25-26 学年",)),
    )


def _complete() -> MemberQueryResult:
    """读全了，只是这个人真的没有活动记录。"""
    return MemberQueryResult(
        found=True, member=_member(), participations=(), bases_unread=()
    )


def test_incomplete_is_not_the_same_as_unavailable():
    """两者必须分开：一个是「有数据但不全」，一个是「一点都没有」。"""
    assert embed.is_incomplete(_incomplete()) is True
    assert embed.is_unavailable(_incomplete()) is False
    assert embed.is_incomplete(_found()) is False
    assert embed.is_incomplete(_unavailable("x")) is False


def test_incomplete_is_retried_once():
    """瞬时故障（限流/抖动）等一拍往往就好了 —— 完整结果优先。"""
    seq = [_incomplete(), _found()]
    slept: list[float] = []

    result = embed.query_with_retry(lambda: seq.pop(0), delay=0.01, sleep=slept.append)

    assert result.found is True
    assert slept == [0.01], "不完整也应当重试一次"


def test_still_incomplete_raises_but_carries_the_data():
    """两次都没读全：抛出 QueryIncomplete，**异常里带着那份数据**（不完整 ≠ 不可用）。"""
    with pytest.raises(embed.QueryIncomplete) as excinfo:
        embed.query_with_retry(
            lambda: _incomplete("25-26 学年"), delay=0.0, sleep=lambda _s: None
        )

    assert excinfo.value.result.found is True
    assert "25-26 学年" in str(excinfo.value) or excinfo.value.result.bases_unread == ("25-26 学年",)


def test_an_incomplete_result_is_never_cached(monkeypatch):
    """🚩 与「没查成」同样的陷阱：残缺结果被缓存住 = 用户重试多少次都是同一份残缺。

    ``st.cache_data`` 不缓存抛异常的调用，所以不完整必须**抛**。
    判据：两次调用各跑满 2 次（各重试 1 次）= 4 次；被缓存住的话第二次只有 1 次。
    """
    monkeypatch.setattr(embed, "RETRY_DELAY_SECONDS", 0.0)
    calls: list[str] = []

    def fake_once(name: str, sid: str) -> MemberQueryResult:
        calls.append(name)
        return _incomplete()

    monkeypatch.setattr(embed, "_query_once", fake_once)
    embed.run_query.clear()

    for _ in range(2):
        with pytest.raises(embed.QueryIncomplete):
            embed.run_query("高梓凯", "2300017473")

    assert len(calls) == 4, f"残缺结果被缓存住了（只跑了 {len(calls)} 次，应为 4 次）"


def test_a_complete_success_is_not_retried_at_all():
    """读全了就一次都不多打 —— 别把「值不值得重试」放宽成恒真。"""
    calls: list[int] = []

    def once() -> MemberQueryResult:
        calls.append(1)
        return MemberQueryResult(
            found=True, member=None, participations=(), bases_unread=()
        )

    embed.query_with_retry(once, delay=0.0, sleep=lambda _s: None)
    assert len(calls) == 1


def test_incomplete_payload_tells_the_frontend_which_bases_were_unread(monkeypatch):
    """载荷必须带上「哪些库没读到」。

    少了这个字段，前端就无法把「系统没读到」和「你的记录没建关联」分开 ——
    两件事的用户动作完全相反（一个稍等重试，一个去找骨干补数据）。
    """
    monkeypatch.setattr(embed, "run_query", lambda *a, **k: _incomplete("25-26 学年"))

    out = embed.query_payload("高梓凯", "2300017473")

    assert out["status"] == payload.STATUS_OK, "不完整也要照常出结果，不是 ERROR"
    assert out["unreadBases"] == ["25-26 学年"]


def test_incomplete_without_activities_still_returns_ok_not_error(monkeypatch):
    """用户报的那一格：0 场活动 + 有库没读到 → 仍是 OK 载荷，但带着 unreadBases。

    前端据此显示「这次没能读全」而不是「去联系骨干补关联」。
    """
    monkeypatch.setattr(embed, "run_query", lambda *a, **k: _incomplete("25-26 学年"))

    out = embed.query_payload("高梓凯", "2300017473")

    assert out["status"] == payload.STATUS_OK
    assert out["unreadBases"] == ["25-26 学年"]
    assert set(out) == {"status", "member", "degraded", "unreadBases"}


def test_unread_bases_never_leak_into_a_normal_result():
    """读全了就是空列表 —— 别让前端无缘无故挂一句「没读全」。"""
    assert payload.build_payload(_complete(), degraded=False)["unreadBases"] == []
