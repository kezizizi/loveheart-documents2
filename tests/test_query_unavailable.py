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
