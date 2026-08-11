from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta


@dataclass(frozen=True)
class ExtraWorkDocumentDates:
    order_date: date
    execution_start: date
    execution_end: date


def validate_iso_week(iso_year: int, iso_week: int) -> None:
    """Reject calendar weeks that do not exist in the requested ISO week-year."""
    try:
        date.fromisocalendar(iso_year, iso_week, 1)
    except ValueError as error:
        raise ValueError(f"KW {iso_week} existiert im ISO-Jahr {iso_year} nicht.") from error


def iso_week_range(iso_year: int, iso_week: int) -> tuple[date, date]:
    validate_iso_week(iso_year, iso_week)
    start = date.fromisocalendar(iso_year, iso_week, 1)
    return start, start + timedelta(days=6)


def resolve_extra_work_document_dates(
    *,
    created_at: datetime | None,
    assignment_start_date: date | None,
    manual_order_date: date | None,
    manual_execution_week: int | None,
    manual_execution_week_year: int | None,
) -> ExtraWorkDocumentDates:
    automatic_order_date = created_at.date() if created_at else date.today()
    order_date = manual_order_date or automatic_order_date

    if manual_execution_week is not None and manual_execution_week_year is not None:
        execution_start, execution_end = iso_week_range(
            manual_execution_week_year,
            manual_execution_week,
        )
    else:
        reference_date = assignment_start_date or automatic_order_date
        execution_start = reference_date - timedelta(days=reference_date.weekday())
        execution_end = execution_start + timedelta(days=6)

    return ExtraWorkDocumentDates(
        order_date=order_date,
        execution_start=execution_start,
        execution_end=execution_end,
    )
