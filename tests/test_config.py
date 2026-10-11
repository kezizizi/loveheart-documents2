"""配置加载：缺失时要说清「到底读到了什么」。

起因是一次真实事故 —— 用户在云端填了密钥仍报「缺少飞书应用凭证」，
而原实现把「secrets 读不出来」和「没填凭证」混成了同一句话，
让人对着完全正确的配置反复检查。
"""

from __future__ import annotations

import pytest

import streamlit as st

from config import ConfigError, load_settings


class _ExplodingSecrets:
    """模拟 TOML 语法错误：迭代 secrets 时抛异常。"""

    def __iter__(self):
        raise RuntimeError("Invalid statement (at line 3, column 1)")


class StreamlitSecretNotFoundError(Exception):
    """名字与 Streamlit 内部异常一致，用于验证「没建文件」走正常回退。"""


class _NoSecretsFile:
    def __iter__(self):
        raise StreamlitSecretNotFoundError("No secrets found")


def _patch(monkeypatch, secrets) -> None:
    monkeypatch.setattr(st, "secrets", secrets, raising=False)


def _clear_env(monkeypatch) -> None:
    for key in (
        "APP_ID",
        "APP_SECRET",
        "BASE_25_26_TOKEN",
        "BASE_25_26_TABLE_ID",
        "BASE_26_27_TOKEN",
        "BASE_26_27_TABLE_ID",
    ):
        monkeypatch.delenv(key, raising=False)


# --------------------------------------------------------------------------
# 正常路径
# --------------------------------------------------------------------------


def test_valid_secrets_are_loaded(monkeypatch):
    _clear_env(monkeypatch)
    _patch(
        monkeypatch,
        {
            "feishu": {"app_id": "cli_x", "app_secret": "s"},
            "base_25_26": {"base_token": "t1", "main_table_id": "m1"},
            "base_26_27": {"base_token": "t2", "main_table_id": "m2"},
        },
    )

    settings = load_settings()

    assert settings.app_id == "cli_x"
    assert [b.key for b in settings.bases] == ["base_25_26", "base_26_27"]
    assert settings.bases[1].main_table_id == "m2"


def test_missing_secrets_file_is_normal_and_falls_back_to_env(monkeypatch):
    """没有 secrets.toml 属正常情况 —— 可以只靠环境变量。"""
    _clear_env(monkeypatch)
    _patch(monkeypatch, _NoSecretsFile())
    monkeypatch.setenv("APP_ID", "cli_env")
    monkeypatch.setenv("APP_SECRET", "sec_env")
    monkeypatch.setenv("BASE_25_26_TOKEN", "t1")
    monkeypatch.setenv("BASE_25_26_TABLE_ID", "m1")
    monkeypatch.setenv("BASE_26_27_TOKEN", "t2")
    monkeypatch.setenv("BASE_26_27_TABLE_ID", "m2")

    settings = load_settings()

    assert settings.app_id == "cli_env"
    assert len(settings.bases) == 2


def test_demo_mode_does_not_require_credentials(monkeypatch):
    _clear_env(monkeypatch)
    _patch(monkeypatch, {})
    monkeypatch.setenv("BASE_25_26_TOKEN", "t1")
    monkeypatch.setenv("BASE_25_26_TABLE_ID", "m1")
    monkeypatch.setenv("BASE_26_27_TOKEN", "t2")
    monkeypatch.setenv("BASE_26_27_TABLE_ID", "m2")

    settings = load_settings(require_credentials=False)

    assert settings.app_id == ""


# --------------------------------------------------------------------------
# 缺配置时必须说清原因
# --------------------------------------------------------------------------


def test_credentials_pasted_without_section_header_says_so(monkeypatch):
    """真实事故：只粘了 app_id / app_secret 两行，没写 [feishu] 段头。"""
    _clear_env(monkeypatch)
    _patch(monkeypatch, {"app_id": "cli_x", "app_secret": "topsecret"})

    with pytest.raises(ConfigError) as info:
        load_settings()

    message = str(info.value)
    assert "顶层" in message, "必须点出这两项没被放进任何 [段]"
    assert "[feishu]" in message
    assert "topsecret" not in message, "报错里绝不能出现密钥值"


def test_mis_cased_section_is_visible_in_the_diagnosis(monkeypatch):
    _clear_env(monkeypatch)
    _patch(monkeypatch, {"Feishu": {"app_id": "cli_x", "app_secret": "s"}})

    with pytest.raises(ConfigError) as info:
        load_settings()

    assert "[Feishu]" in str(info.value), "要把实际读到的段名摊开给用户看"


def test_malformed_secrets_surfaces_the_parse_error(monkeypatch):
    """⚠️ TOML 坏了 ≠ 没填凭证。绝不能把前者伪装成后者。"""
    _clear_env(monkeypatch)
    _patch(monkeypatch, _ExplodingSecrets())

    with pytest.raises(ConfigError) as info:
        load_settings()

    message = str(info.value)
    assert "读取 secrets 失败" in message
    assert "Invalid statement" in message


def test_missing_base_section_names_the_section(monkeypatch):
    _clear_env(monkeypatch)
    _patch(monkeypatch, {"feishu": {"app_id": "cli_x", "app_secret": "s"}})

    with pytest.raises(ConfigError) as info:
        load_settings()

    message = str(info.value)
    assert "base_25_26" in message
    assert "base_token" in message
