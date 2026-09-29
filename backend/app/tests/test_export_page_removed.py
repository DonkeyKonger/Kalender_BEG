import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes import exports
from app.core.office_permissions import OFFICE_PAGE_PERMISSIONS, normalize_office_page_permissions
from app.services.simple_pdf import SimplePdf
from app.services.time_entry_xlsx_export_service import TimeEntryXlsxExportService


@pytest.mark.parametrize("path", [
    "/exports/daily-plan?date=2026-09-29",
    "/exports/weekly-plan?week_start=2026-09-28",
    "/exports/time-entries/monthly-xlsx?year=2026&month=9",
])
def test_retired_export_endpoints_are_not_registered(path):
    app = FastAPI()
    app.include_router(exports.router)
    assert TestClient(app).get(path).status_code == 404
    assert not hasattr(TimeEntryXlsxExportService, "monthly_export")


def test_old_export_permission_is_ignored_without_breaking_existing_accounts():
    assert "export" not in OFFICE_PAGE_PERMISSIONS
    assert normalize_office_page_permissions(["export", "payroll", "overview"]) == ["overview", "payroll"]
    assert normalize_office_page_permissions(["export"]) == []
    with pytest.raises(ValueError):
        normalize_office_page_permissions(["unknown"])


def test_shared_payroll_pdf_writer_remains_available():
    pdf = SimplePdf()
    pdf.add_heading("Arbeitsstunden")
    pdf.text("Test")
    assert pdf.render().startswith(b"%PDF-1.4")
