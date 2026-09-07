from datetime import date, time, timedelta
from io import BytesIO
from zipfile import ZipFile

import pytest
from sqlalchemy import event

from app.models.work_time_entry import WorkTimeEntry
from app.services.gps_service import GpsPresenceService
from app.services.time_entry_xlsx_export_service import TimeEntryXlsxExportService
from app.tests.test_payroll_month_close_service import database, payroll_users


def workbook_parts(content):
    with ZipFile(BytesIO(content)) as workbook:
        return {name: workbook.read(name) for name in workbook.namelist()}


@pytest.mark.parametrize("kind", ["monthly", "weekly_worker", "weekly_all_workers"])
def test_export_batches_gps_queries_without_changing_workbook(kind, monkeypatch):
    with database() as db:
        admin, worker = payroll_users(db)
        start = date(2026, 8, 24)
        db.add_all([
            WorkTimeEntry(
                person_id=worker.id, work_date=start + timedelta(days=index % 5),
                start_time=time(6 + index // 5), end_time=time(7 + index // 5),
                work_minutes=60, break_minutes=0, source="manual",
            ) for index in range(20)
        ])
        db.commit()
        service = TimeEntryXlsxExportService(db)
        def export():
            if kind == "monthly":
                return service.monthly_export(year=2026, month=8, current_user=admin)
            if kind == "weekly_worker":
                return service.weekly_worker_export(person_id=worker.id, week_start=start, current_user=admin)
            return service.weekly_all_workers_export(week_start=start, current_user=admin)

        original_batch = GpsPresenceService.evaluate_time_entries
        statements = []
        def record(_conn, _cursor, statement, _parameters, _context, _executemany):
            if statement.lstrip().upper().startswith("SELECT"):
                statements.append(statement)
        event.listen(db.bind, "before_cursor_execute", record)
        # Reference behaviour from the old per-entry export, using real GPS logic.
        monkeypatch.setattr(GpsPresenceService, "evaluate_time_entries", lambda self, entries: {
            entry.id: original_batch(self, [entry])[entry.id] for entry in entries
        })
        expected = workbook_parts(export())
        previous_queries = len(statements)
        statements.clear()
        batches = []
        def batch(self, entries):
            batches.append([entry.id for entry in entries])
            return original_batch(self, entries)
        monkeypatch.setattr(GpsPresenceService, "evaluate_time_entries", batch)
        actual = workbook_parts(export())
        assert actual == expected
        assert len(batches) == 1
        assert len(batches[0]) == 20
        assert len(statements) < previous_queries / 3
        event.remove(db.bind, "before_cursor_execute", record)
