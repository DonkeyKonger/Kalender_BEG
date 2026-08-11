from datetime import UTC, date, datetime

import pytest
from pydantic import ValidationError

from app.schemas.extra_work import ExtraWorkTicketDetailsUpdate
from app.services.extra_work_dates import iso_week_range, resolve_extra_work_document_dates


def test_extra_work_document_dates_keep_existing_automatic_defaults_for_old_records():
    values = resolve_extra_work_document_dates(
        created_at=datetime(2026, 8, 11, 14, 45, tzinfo=UTC),
        assignment_start_date=date(2026, 8, 11),
        manual_order_date=None,
        manual_execution_week=None,
        manual_execution_week_year=None,
    )

    assert values.order_date == date(2026, 8, 11)
    assert values.execution_start == date(2026, 8, 10)
    assert values.execution_end == date(2026, 8, 16)


def test_extra_work_document_dates_apply_order_and_iso_week_overrides_independently():
    only_order = resolve_extra_work_document_dates(
        created_at=datetime(2026, 8, 11, tzinfo=UTC),
        assignment_start_date=date(2026, 8, 11),
        manual_order_date=date(2026, 8, 4),
        manual_execution_week=None,
        manual_execution_week_year=None,
    )
    only_week = resolve_extra_work_document_dates(
        created_at=datetime(2026, 8, 11, tzinfo=UTC),
        assignment_start_date=date(2026, 8, 11),
        manual_order_date=None,
        manual_execution_week=1,
        manual_execution_week_year=2025,
    )

    assert only_order.order_date == date(2026, 8, 4)
    assert (only_order.execution_start, only_order.execution_end) == (
        date(2026, 8, 10),
        date(2026, 8, 16),
    )
    assert only_week.order_date == date(2026, 8, 11)
    assert (only_week.execution_start, only_week.execution_end) == (
        date(2024, 12, 30),
        date(2025, 1, 5),
    )


def test_iso_week_validation_handles_year_boundary_and_rejects_nonexistent_week_53():
    assert iso_week_range(2025, 1) == (date(2024, 12, 30), date(2025, 1, 5))

    with pytest.raises(ValidationError, match="existiert im ISO-Jahr 2025 nicht"):
        ExtraWorkTicketDetailsUpdate(
            manual_execution_week=53,
            manual_execution_week_year=2025,
        )

    with pytest.raises(ValidationError, match="gemeinsam angegeben"):
        ExtraWorkTicketDetailsUpdate(manual_execution_week=33)
