from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Protocol
from zoneinfo import ZoneInfo


DOCUMENT_TIMEZONE = ZoneInfo("Europe/Berlin")
REVIEWED_OR_COMPLETED_STATUSES = frozenset(
    {
        "reviewed",
        "checked",
        "billed",
        "approved",
        "closed",
        "completed",
        "finalized",
        "abgeschlossen",
    }
)


class _MeasurementDocumentDates(Protocol):
    first_worker_submitted_at: datetime | None
    first_reviewed_or_completed_at: datetime | None


class _ExtraWorkDocumentDates(Protocol):
    first_submitted_at: datetime | None
    first_reviewed_or_completed_at: datetime | None


def measurement_document_date(batch: _MeasurementDocumentDates) -> date | None:
    """Prefer the migration-validated first worker submission."""
    return _berlin_date(
        batch.first_worker_submitted_at or batch.first_reviewed_or_completed_at
    )


def extra_work_document_date(ticket: _ExtraWorkDocumentDates) -> date | None:
    """Prefer the first worker submission over the first later office event."""
    return _berlin_date(
        ticket.first_submitted_at or ticket.first_reviewed_or_completed_at
    )


def _berlin_date(value: datetime | None) -> date | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(DOCUMENT_TIMEZONE).date()
