from fastapi import Response, status
import pytest

from app.api.routes import health
from app.scripts import import_tools_from_excel
from app.scripts.import_bundled_tools import (
    EXPECTED_SHA256,
    SOURCE_RELATIVE_PATH,
    resolve_app_root,
    resolve_bundled_source,
    resolve_data_root,
    verify_bundled_source,
)
from app.services.tool_material_excel_import import ImportReport


def test_bundled_source_is_resolved_from_module_location():
    app_root = resolve_app_root()
    source_file = resolve_bundled_source()

    assert source_file == (app_root / SOURCE_RELATIVE_PATH).resolve()
    assert source_file.is_file()
    verification = verify_bundled_source()
    assert verification["sha256"] == EXPECTED_SHA256
    assert verification["relative_path"] == SOURCE_RELATIVE_PATH.as_posix()
    assert verification["physical_tool_rows"] == 898


def test_missing_bundled_source_reports_resolved_paths_and_directory_contents(tmp_path):
    (tmp_path / "present.txt").write_text("diagnostic", encoding="utf-8")

    with pytest.raises(FileNotFoundError) as error:
        resolve_bundled_source(tmp_path)

    message = str(error.value)
    assert f"Aufgelöster App-Root: {tmp_path.resolve()}" in message
    assert SOURCE_RELATIVE_PATH.as_posix() in message
    assert str((tmp_path / SOURCE_RELATIVE_PATH).resolve()) in message
    assert "present.txt" in message


def test_data_root_uses_home_without_hard_coded_azure_path(monkeypatch, tmp_path):
    monkeypatch.delenv("TOOL_IMPORT_DATA_ROOT", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))

    assert resolve_data_root() == (tmp_path / "data" / "kalender-beg-tool-import").resolve()


def test_data_root_can_be_overridden(monkeypatch, tmp_path):
    configured = tmp_path / "configured-import-state"
    monkeypatch.setenv("TOOL_IMPORT_DATA_ROOT", str(configured))

    assert resolve_data_root() == configured.resolve()


def test_noop_apply_is_idempotent_and_does_not_create_another_backup(
    monkeypatch,
    tmp_path,
):
    report = ImportReport(
        mode="source",
        file=str(tmp_path / "source.xlsx"),
        physical_tool_rows=1,
    )
    fake_row = object()

    class FakeSession:
        def __init__(self):
            self.rollbacks = 0
            self.closed = False

        def rollback(self):
            self.rollbacks += 1

        def close(self):
            self.closed = True

    session = FakeSession()

    class FakeImporter:
        def __init__(self, _db, _rows, current_report):
            self.report = current_report

        def plan(self):
            self.report.existing_matches = 1
            self.report.unchanged = 1
            return [("unchanged", fake_row, None, {})]

    monkeypatch.setattr(
        import_tools_from_excel,
        "read_source_rows",
        lambda _source: ([fake_row], report),
    )
    monkeypatch.setattr(import_tools_from_excel, "ToolMaterialExcelImporter", FakeImporter)
    monkeypatch.setattr(
        import_tools_from_excel,
        "create_backup",
        lambda *_args: pytest.fail("Ein No-op-Import darf kein Backup erzeugen."),
    )

    result, current_report = import_tools_from_excel.execute_import(
        tmp_path / "source.xlsx",
        apply=True,
        backup_dir=tmp_path / "backups",
        session_factory=lambda: session,
    )

    assert result == 0
    assert current_report.applied is True
    assert current_report.already_applied is True
    assert session.rollbacks == 1
    assert session.closed is True


def test_startup_runs_bundled_import_after_migrations_and_before_gunicorn():
    startup_script = (resolve_app_root() / "startup.sh").read_text(encoding="utf-8")

    migration_index = startup_script.index("alembic upgrade head")
    import_index = startup_script.index("run_tool_import &")
    gunicorn_index = startup_script.index("exec gunicorn")

    assert migration_index < import_index < gunicorn_index
    assert "if python -m app.scripts.import_bundled_tools; then" in startup_script
    assert "Werkzeugimport im Hintergrund gestartet" in startup_script
    assert "API-Start wird nicht blockiert" in startup_script


def test_tool_import_health_reports_pending_and_ready(monkeypatch):
    monkeypatch.setattr(health, "bundled_source_keys", lambda: frozenset({"one", "two"}))

    class FakeSession:
        def __init__(self, imported_rows):
            self.imported_rows = imported_rows

        def scalar(self, _query):
            return self.imported_rows

    pending_response = Response()
    pending = health.tool_import_health(pending_response, FakeSession(1))
    assert pending_response.status_code == status.HTTP_503_SERVICE_UNAVAILABLE
    assert pending["status"] == "pending"
    assert pending["imported_rows"] == 1

    ready_response = Response()
    ready = health.tool_import_health(ready_response, FakeSession(2))
    assert ready_response.status_code == status.HTTP_200_OK
    assert ready == {
        "status": "ok",
        "source_sha256": EXPECTED_SHA256,
        "expected_rows": 2,
        "imported_rows": 2,
    }
