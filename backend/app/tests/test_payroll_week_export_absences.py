from datetime import date, time, timedelta
from io import BytesIO
from zipfile import ZipFile
import xml.etree.ElementTree as ET

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.models.absence import Absence
from app.models.enums import AbsenceStatus, AbsenceType
from app.models.person import Person
from app.models.work_time_entry import WorkTimeEntry
from app.services.person_hours_account_service import calculate_weekly_hours_breakdown
from app.services.time_entry_xlsx_export_service import (
    TimeEntryXlsxExportService, weekly_worker_rows, weekly_worker_total_minutes,
)
from app.tests.test_payroll_month_close_service import database, payroll_users
from app.tests.test_time_entry_xlsx_export_service import cell_text, workbook_sheet, NS

START = date(2026, 8, 31)
END = START + timedelta(days=6)


def absence(kind, start=START, end=END, status=AbsenceStatus.ACTIVE, **kwargs):
    return Absence(absence_type=kind, start_date=start, end_date=end, status=status, **kwargs)


@pytest.mark.parametrize("kind,label", [(AbsenceType.VACATION, "Urlaub"),
    (AbsenceType.SICK, "Krankheit"), (AbsenceType.FREE, "Überstundenabbau")])
def test_absence_only_week_in_both_exports_matches_calendar_and_creates_no_time_entries(kind, label):
    with database() as db:
        admin, worker = payroll_users(db)
        item = absence(kind, person_id=worker.id)
        db.add(item)
        db.commit()
        service = TimeEntryXlsxExportService(db)
        single = service.weekly_worker_export(person_id=worker.id, week_start=START, current_user=admin)
        combined = service.weekly_all_workers_export(week_start=START, current_user=admin)
        calendar = calculate_weekly_hours_breakdown(entries=[], absences=[item], start=START, end=END)
        assert calendar.actual_minutes == 2400
        for content in (single, combined):
            _, sheet = workbook_sheet(content)
            assert [cell_text(sheet, f"C{row}") for row in range(15, 20)] == [label] * 5
            assert [cell_text(sheet, f"O{row}") for row in range(15, 20)] == ["8,00 h"] * 5
            assert cell_text(sheet, "O26") == "40,00 h"
            assert all(cell_text(sheet, f"{column}{row}") == "" for row in range(15, 20) for column in "JKLMN")
        assert list(db.scalars(select(WorkTimeEntry))) == []
        assert item.status == AbsenceStatus.ACTIVE


def test_partial_day_uses_printed_corrected_work_travel_and_rounding_without_double_credit():
    entry = WorkTimeEntry(work_date=START, work_minutes=500, travel_minutes=30,
        break_minutes=0, payroll_corrected_work_minutes=242)
    rows = weekly_worker_rows(START, END, [entry], {}, [absence(AbsenceType.VACATION), absence(AbsenceType.VACATION)])
    assert weekly_worker_total_minutes(rows[0]) == 270
    assert rows[1].absence_credit.credit_minutes == 210
    assert sum(weekly_worker_total_minutes(row) for row in rows) == 2400
    assert len([row for row in rows if row.absence_credit]) == 5


def test_work_derived_from_clock_times_and_long_days_do_not_receive_duplicate_hours():
    entries = [WorkTimeEntry(work_date=START, start_time=time(6), end_time=time(15),
        work_minutes=0, break_minutes=60, travel_minutes=0),
        WorkTimeEntry(work_date=START + timedelta(days=1), work_minutes=600, travel_minutes=0, break_minutes=0)]
    rows = weekly_worker_rows(START, END, entries, {}, [absence(AbsenceType.SICK)])
    assert [row.absence_credit.credit_minutes for row in rows if row.absence_credit] == [0, 0, 480, 480, 480]
    assert sum(weekly_worker_total_minutes(row) for row in rows) == 2520


def test_calendar_overlap_priority_cancellations_weekends_and_week_boundaries_are_preserved():
    items = [absence(AbsenceType.VACATION, START - timedelta(days=2), START),
        absence(AbsenceType.SICK, START, START), absence(AbsenceType.FREE, START, START),
        absence(AbsenceType.VACATION, START + timedelta(days=1), END, AbsenceStatus.CANCELLED),
        absence(AbsenceType.SICK, START + timedelta(days=5), END + timedelta(days=2))]
    rows = weekly_worker_rows(START, END, [], {}, items)
    calendar = calculate_weekly_hours_breakdown(entries=[], absences=items, start=START, end=END)
    assert [row.absence_credit for row in rows if row.absence_credit] == list(calendar.daily_absence_credits)
    assert rows[0].absence_credit.absence_type == AbsenceType.FREE
    assert sum(weekly_worker_total_minutes(row) for row in rows) == 480
    assert len(rows) == 5


def test_iso_week_crossing_year_boundary_keeps_only_its_weekday_credits():
    start = date.fromisocalendar(2026, 53, 1)
    end = start + timedelta(days=6)
    rows = weekly_worker_rows(start, end, [], {}, [
        absence(AbsenceType.VACATION, start - timedelta(days=7), end + timedelta(days=7))])
    assert [row.work_date for row in rows] == [start + timedelta(days=index) for index in range(5)]
    assert rows[-1].work_date == date(2027, 1, 1)
    assert sum(weekly_worker_total_minutes(row) for row in rows) == 2400


def test_combined_export_includes_absence_only_person_and_single_export_is_person_scoped():
    with database() as db:
        admin, worker = payroll_users(db)
        other = Person(first_name="Zoe", last_name="Urlaub", display_name="Zoe Urlaub", short_code="ZU")
        db.add(other)
        db.flush()
        db.add_all([WorkTimeEntry(person_id=worker.id, work_date=START, work_minutes=120,
            break_minutes=0, travel_minutes=0), absence(AbsenceType.VACATION, person_id=other.id)])
        db.commit()
        service = TimeEntryXlsxExportService(db)
        _, single = workbook_sheet(service.weekly_worker_export(person_id=worker.id, week_start=START, current_user=admin))
        assert cell_text(single, "O26") == "2,00 h"
        with ZipFile(BytesIO(service.weekly_all_workers_export(week_start=START, current_user=admin))) as xlsx:
            sheet_names = ET.fromstring(xlsx.read("xl/workbook.xml")).findall("main:sheets/main:sheet", NS)
            assert len(sheet_names) == 2
            sheets = [ET.fromstring(xlsx.read(f"xl/worksheets/sheet{index}.xml")) for index in (1, 2)]
            assert {cell_text(sheet, "O26") for sheet in sheets} == {"2,00 h", "40,00 h"}


@pytest.mark.parametrize("kind,start,end,status", [
    (AbsenceType.VACATION, START, END, AbsenceStatus.CANCELLED),
    (AbsenceType.SICK, START + timedelta(days=5), END, AbsenceStatus.ACTIVE),
    (AbsenceType.FREE, END + timedelta(days=1), END + timedelta(days=5), AbsenceStatus.ACTIVE),
    (AbsenceType.SCHOOL, START, END, AbsenceStatus.ACTIVE),
])
def test_nonqualifying_absences_do_not_add_workers_to_export(kind, start, end, status):
    with database() as db:
        admin, worker = payroll_users(db)
        db.add(absence(kind, start, end, status, person_id=worker.id))
        db.commit()
        with pytest.raises(HTTPException) as error:
            TimeEntryXlsxExportService(db).weekly_all_workers_export(week_start=START, current_user=admin)
        assert error.value.status_code == 404
