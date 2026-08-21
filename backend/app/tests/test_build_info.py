from pathlib import Path

from app.api.routes import health
from app.core import build_info


def test_build_revision_uses_environment(monkeypatch) -> None:
    monkeypatch.setenv("APP_BUILD_SHA", "a" * 40)

    assert build_info.get_build_revision() == "a" * 40


def test_build_revision_uses_packaged_file(monkeypatch, tmp_path: Path) -> None:
    revision_file = tmp_path / "build_sha.txt"
    revision_file.write_text("b" * 40 + "\n", encoding="utf-8")
    monkeypatch.delenv("APP_BUILD_SHA", raising=False)
    monkeypatch.setattr(build_info, "BUILD_REVISION_PATH", revision_file)

    assert build_info.get_build_revision() == "b" * 40


def test_build_revision_rejects_invalid_value(monkeypatch, tmp_path: Path) -> None:
    revision_file = tmp_path / "build_sha.txt"
    revision_file.write_text("not-a-commit", encoding="utf-8")
    monkeypatch.delenv("APP_BUILD_SHA", raising=False)
    monkeypatch.setattr(build_info, "BUILD_REVISION_PATH", revision_file)

    assert build_info.get_build_revision() == "development"


def test_health_exposes_deployed_revision(monkeypatch) -> None:
    monkeypatch.setattr(health, "get_build_revision", lambda: "c" * 40)

    assert health.health()["revision"] == "c" * 40
