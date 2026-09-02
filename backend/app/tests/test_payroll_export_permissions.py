from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.dependencies import get_current_user
from app.api.routes import exports
from app.core.database import get_db
from app.models.enums import UserRole


PAYROLL_XLSX_PATHS = (
    "/api/exports/time-entries/weekly-worker-xlsx?person_id=17&week_start=2026-07-27",
    "/api/exports/time-entries/weekly-workers-xlsx?week_start=2026-07-27",
    "/api/exports/time-entries/payroll-monthly-worker-xlsx?person_id=17&year=2026&month=8",
    "/api/exports/time-entries/payroll-monthly-workers-xlsx?year=2026&month=8",
)


def user(role: UserRole, *permissions: str):
    return SimpleNamespace(
        id=7,
        role=role,
        is_active=True,
        must_change_password=False,
        office_page_permissions=list(permissions),
        person_id=None,
    )


class FakeTimeEntryXlsxExportService:
    def __init__(self, _db) -> None:
        pass

    def weekly_worker_export(self, **_kwargs) -> bytes:
        return b"weekly-worker-xlsx"

    def weekly_all_workers_export(self, **_kwargs) -> bytes:
        return b"weekly-workers-xlsx"


class FakePayrollMonthExportService:
    def __init__(self, _db) -> None:
        pass

    def worker_export(self, **_kwargs) -> bytes:
        return b"payroll-monthly-worker-xlsx"

    def all_workers_export(self, **_kwargs) -> bytes:
        return b"payroll-monthly-workers-xlsx"


def payroll_export_client(monkeypatch, current_user) -> TestClient:
    app = FastAPI()
    app.include_router(exports.router, prefix="/api")
    app.dependency_overrides[get_current_user] = lambda: current_user
    app.dependency_overrides[get_db] = lambda: object()
    monkeypatch.setattr(exports, "TimeEntryXlsxExportService", FakeTimeEntryXlsxExportService)
    monkeypatch.setattr(exports, "PayrollMonthExportService", FakePayrollMonthExportService)
    return TestClient(app)


@pytest.mark.parametrize("path", PAYROLL_XLSX_PATHS)
def test_office_with_payroll_opt_in_can_download_weekly_payroll_xlsx(
    monkeypatch,
    path: str,
):
    response = payroll_export_client(
        monkeypatch,
        user(UserRole.OFFICE, "payroll"),
    ).get(path)

    assert response.status_code == 200
    assert response.headers["content-type"] == (
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    )


@pytest.mark.parametrize("path", PAYROLL_XLSX_PATHS)
def test_office_without_payroll_opt_in_cannot_download_weekly_payroll_xlsx(
    monkeypatch,
    path: str,
):
    response = payroll_export_client(
        monkeypatch,
        user(UserRole.OFFICE, "export"),
    ).get(path)

    assert response.status_code == 403


@pytest.mark.parametrize("path", PAYROLL_XLSX_PATHS)
@pytest.mark.parametrize("role", [UserRole.ADMIN, UserRole.PROJECT_MANAGER])
def test_existing_management_roles_keep_weekly_payroll_xlsx_access(
    monkeypatch,
    path: str,
    role: UserRole,
):
    response = payroll_export_client(monkeypatch, user(role)).get(path)

    assert response.status_code == 200


@pytest.mark.parametrize("path", PAYROLL_XLSX_PATHS)
def test_monteur_cannot_download_weekly_payroll_xlsx(monkeypatch, path: str):
    response = payroll_export_client(monkeypatch, user(UserRole.MONTEUR)).get(path)

    assert response.status_code == 403
