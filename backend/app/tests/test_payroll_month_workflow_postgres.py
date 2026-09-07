"""Exercise real monthly services and retained exports on the migrated database."""

from io import BytesIO
from zipfile import ZipFile

import pytest
from sqlalchemy import select

from app.models.person_hours_account import PersonHoursAccountEntry
from app.services.payroll_month_close_service import PayrollMonthCloseService
from app.services.payroll_month_export_service import PayrollMonthExportService
from app.tests import test_payroll_month_postgres as postgres_tests

pg_session = postgres_tests.pg_session

pytestmark = pytest.mark.skipif(not postgres_tests.POSTGRES_URL, reason="requires isolated migrated PostgreSQL")


def test_postgres_archived_renamed_person_keeps_approved_export_and_reopens_once(pg_session):
    admin, worker = postgres_tests._payroll_users(pg_session)
    original_name = worker.display_name
    pg_session.commit()
    service = PayrollMonthCloseService(pg_session)
    before = service.get_status(year=2026, month=8, current_user=admin)
    person = next(item for item in before.person_approvals if item.person_id == worker.id)
    approved = service.approve_person_month(
        year=2026, month=8, person_id=worker.id, confirmed=True,
        acknowledged_blocker_count=len(person.blockers),
        acknowledged_blocker_fingerprint=person.blocker_fingerprint,
        current_user=admin,
    )
    person = next(item for item in approved.person_approvals if item.person_id == worker.id)
    assert person.status == "APPROVED" and person.export_ready
    exports = PayrollMonthExportService(pg_session)
    original_content = exports.worker_export(
        year=2026, month=8, person_id=worker.id, current_user=admin,
    )
    with ZipFile(BytesIO(original_content)) as workbook:
        assert "xl/workbook.xml" in workbook.namelist()
    original_postings = list(pg_session.scalars(select(PersonHoursAccountEntry).where(
        PersonHoursAccountEntry.person_id == worker.id,
    )))
    original_ids = {posting.id for posting in original_postings}

    worker.display_name = "Archived and renamed test worker"
    worker.is_active = False
    pg_session.commit()
    retained = service.get_status(year=2026, month=8, current_user=admin)
    person = next(item for item in retained.person_approvals if item.person_id == worker.id)
    assert person.person_name == original_name
    assert person.status == "APPROVED" and person.export_ready and person.can_reopen
    assert exports.worker_export(
        year=2026, month=8, person_id=worker.id, current_user=admin,
    ) == original_content

    reopened = service.reopen_person_month(
        year=2026, month=8, person_id=worker.id,
        reason="Correct retained monthly approval", current_user=admin,
    )
    assert next(item for item in reopened.person_approvals if item.person_id == worker.id).status == "OPEN"
    postings = list(pg_session.scalars(select(PersonHoursAccountEntry).where(
        PersonHoursAccountEntry.person_id == worker.id,
    )))
    assert original_ids <= {posting.id for posting in postings}
    reversals = [posting for posting in postings if posting.source_type == "payroll_month_reopen"]
    assert len(reversals) == 1
    assert reversals[0].source_payload["reversed_entry_id"] in original_ids
