from __future__ import annotations

import os

import pytest

from app.core.config import (
    AZURE_PRICE_COMPARISON_CACHE_DIR,
    LOCAL_PRICE_COMPARISON_CACHE_DIR,
    Settings,
    ensure_price_comparison_cache_dir,
)


def _settings(monkeypatch: pytest.MonkeyPatch, **environment: str) -> Settings:
    for name in (
        "WEBSITE_INSTANCE_ID",
        "WEBSITE_SITE_NAME",
        "PRICE_COMPARISON_CACHE_DIR",
    ):
        monkeypatch.delenv(name, raising=False)
    for name, value in environment.items():
        monkeypatch.setenv(name, value)
    return Settings(
        _env_file=None,
        DATABASE_URL="sqlite:///:memory:",
        SECRET_KEY="price-cache-config-test",
    )


def test_local_price_cache_default_is_unchanged(monkeypatch) -> None:
    assert _settings(monkeypatch).price_comparison_cache_dir == LOCAL_PRICE_COMPARISON_CACHE_DIR


@pytest.mark.parametrize("azure_marker", ["WEBSITE_INSTANCE_ID", "WEBSITE_SITE_NAME"])
def test_azure_runtime_defaults_price_cache_to_persistent_home(monkeypatch, azure_marker) -> None:
    configured = _settings(monkeypatch, **{azure_marker: "app-instance"})

    assert configured.price_comparison_cache_dir == AZURE_PRICE_COMPARISON_CACHE_DIR
    assert configured.price_comparison_cache_dir.startswith("/home/")


def test_explicit_price_cache_setting_wins_on_azure(monkeypatch, tmp_path) -> None:
    configured = _settings(
        monkeypatch,
        WEBSITE_SITE_NAME="calendar-api",
        PRICE_COMPARISON_CACHE_DIR=str(tmp_path / "explicit-cache"),
    )

    assert configured.price_comparison_cache_dir == str(tmp_path / "explicit-cache")


def test_startup_cache_directory_is_private(tmp_path) -> None:
    directory = ensure_price_comparison_cache_dir(tmp_path / "runtime" / "price-cache")

    assert directory.is_dir()
    assert os.stat(directory).st_mode & 0o777 == 0o700
