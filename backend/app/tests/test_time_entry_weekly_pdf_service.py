from datetime import date
from types import SimpleNamespace

from app.models.enums import PersonType, UserRole
from app.services.time_entry_weekly_pdf_service import (
    WeeklyHoursRow,
    clean_cell,
    format_hours,
    format_table_row,
    is_payroll_worker_person,
)


def test_weekly_pdf_row_uses_reported_hours_without_gps_details():
    row = WeeklyHoursRow(
        work_date=date(2026, 6, 8),
        site_name="Schüchtermann Klinik",
        site_number="8007",
        reported_minutes=450,
        note="Regulär gemeldet",
    )

    rendered = format_table_row(row)

    assert "Mo" in rendered
    assert "08.06.26" in rendered
    assert "Schüchtermann Klinik" in rendered
    assert "8007" in rendered
    assert "7,5 h" in rendered
    assert "GPS" not in rendered


def test_weekly_pdf_helpers_keep_table_cells_compact():
    assert format_hours(480) == "8,0 h"
    assert format_hours(None) == ""
    assert clean_cell("Sehr langer Baustellenname", 10) == "Sehr lang."


def test_payroll_worker_filter_excludes_active_project_managers():
    project_manager = SimpleNamespace(
        is_active=True,
        deleted_at=None,
        person_type=PersonType.INTERNAL,
        users=[SimpleNamespace(is_active=True, role=UserRole.PROJECT_MANAGER)],
    )
    worker = SimpleNamespace(
        is_active=True,
        deleted_at=None,
        person_type=PersonType.INTERNAL,
        users=[SimpleNamespace(is_active=True, role=UserRole.MONTEUR)],
    )
    legacy_worker_without_user = SimpleNamespace(
        is_active=True,
        deleted_at=None,
        person_type=PersonType.INTERNAL,
        users=[],
    )

    assert is_payroll_worker_person(project_manager) is False
    assert is_payroll_worker_person(worker) is True
    assert is_payroll_worker_person(legacy_worker_without_user) is True
