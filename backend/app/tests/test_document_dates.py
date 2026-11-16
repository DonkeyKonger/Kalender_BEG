from datetime import UTC, date, datetime
from types import SimpleNamespace

from app.services.document_dates import (
    extra_work_document_date,
    measurement_document_date,
)


def test_measurement_document_date_prefers_persisted_first_submission_in_berlin():
    batch = SimpleNamespace(
        first_worker_submitted_at=datetime(2026, 11, 2, 23, 30, tzinfo=UTC),
        first_reviewed_or_completed_at=datetime(2026, 11, 1, 8, tzinfo=UTC),
    )

    assert measurement_document_date(batch) == date(2026, 11, 3)


def test_measurement_document_date_survives_submitter_deletion():
    batch = SimpleNamespace(
        first_worker_submitted_at=datetime(2026, 11, 2, 8, tzinfo=UTC),
        first_reviewed_or_completed_at=datetime(2026, 11, 4, 23, 30),
    )

    assert measurement_document_date(batch) == date(2026, 11, 2)


def test_extra_work_document_date_prefers_later_true_worker_submission():
    ticket = SimpleNamespace(
        first_submitted_at=datetime(2026, 11, 6, 9, tzinfo=UTC),
        first_reviewed_or_completed_at=datetime(2026, 11, 4, 9, tzinfo=UTC),
    )

    assert extra_work_document_date(ticket) == date(2026, 11, 6)


def test_document_dates_remain_unknown_without_evidenced_event():
    batch = SimpleNamespace(
        first_worker_submitted_at=None,
        first_reviewed_or_completed_at=None,
    )
    ticket = SimpleNamespace(
        first_submitted_at=None,
        first_reviewed_or_completed_at=None,
    )

    assert measurement_document_date(batch) is None
    assert extra_work_document_date(ticket) is None
