from datetime import date
from io import BytesIO
from zipfile import ZipFile
import xml.etree.ElementTree as ET

import pytest

from app.models.absence import Absence
from app.models.enums import AbsenceStatus, AbsenceType
from app.models.person import Person
from app.services.payroll_month_xlsx_service import (
    PayrollMonthSheet,
    build_payroll_month_plan,
    build_payroll_month_xlsx,
    build_payroll_months_xlsx,
)
from app.tests.test_payroll_month_xlsx_service import (
    NS,
    cell_number_format,
    cell_shrinks_to_fit,
    cell_text,
    entry_snapshot,
    long_week_entries,
    make_entry,
)


PERSON = Person(id=1, display_name="Test Monteur", weekly_hours=40)


def absence(kind, start, end=None, **values):
    return Absence(**{
        "person_id": PERSON.id,
        "absence_type": kind,
        "status": AbsenceStatus.ACTIVE,
        "start_date": start,
        "end_date": end or start,
        **values,
    })


def month_plan(absences, *, year=2026, month=8, entries=(), holidays=()):
    return build_payroll_month_plan(
        person=PERSON, year=year, month=month, entries=entries,
        absences=absences, non_working_dates=holidays,
    )


@pytest.mark.parametrize(("kind", "minutes", "label"), [
    (AbsenceType.VACATION, 480, "Urlaub"),
    (AbsenceType.SICK, 0, "Krankheit"),
])
@pytest.mark.parametrize("weekly_hours", [40, 20, None])
def test_absence_days_have_requested_hours_and_no_invented_work_details(
    monkeypatch, kind, minutes, label, weekly_hours
):
    monkeypatch.setattr(PERSON, "weekly_hours", weekly_hours)
    record = absence(kind, date(2026, 8, 3))
    before = dict(record.__dict__)
    result = build_payroll_month_xlsx(
        person=PERSON, year=2026, month=8, entries=[], absences=[record],
    )

    assert record.__dict__ == before
    assert len(result.plan.days) == 1
    day = result.plan.days[0]
    assert day.work_date == date(2026, 8, 3)
    assert day.absence_type == kind
    assert day.net_work_minutes == minutes
    assert day.source_entry_ids == ()
    assert day.is_derived is False
    assert day.start_time is day.end_time is None
    with ZipFile(BytesIO(result.content)) as workbook:
        assert workbook.testzip() is None
        sheet = ET.fromstring(workbook.read("xl/worksheets/sheet1.xml"))
        styles = ET.fromstring(workbook.read("xl/styles.xml"))
    assert cell_text(sheet, "H12") == label
    assert float(cell_text(sheet, "E12")) * 1440 == pytest.approx(minutes)
    assert float(cell_text(sheet, "E41")) * 1440 == pytest.approx(minutes)
    assert cell_number_format(sheet, styles, "E12") == "[h]:mm"
    assert cell_shrinks_to_fit(sheet, styles, "H12")
    assert all(cell_text(sheet, f"{col}12") == "" for col in "BCDFG")


@pytest.mark.parametrize("kind", [AbsenceType.VACATION, AbsenceType.SICK])
def test_absence_ranges_exclude_weekends_and_configured_holidays(kind):
    plan = month_plan(
        [absence(kind, date(2026, 4, 2), date(2026, 4, 7))],
        month=4, holidays={date(2026, 4, 3), date(2026, 4, 6)},
    )
    assert [day.work_date for day in plan.days] == [date(2026, 4, 2), date(2026, 4, 7)]
    assert sum(day.net_work_minutes for day in plan.days) == (
        960 if kind == AbsenceType.VACATION else 0
    )


@pytest.mark.parametrize(("year", "month", "start", "end", "days"), [
    (2026, 8, date(2026, 7, 30), date(2026, 8, 4), [3, 4]),
    (2026, 8, date(2026, 8, 28), date(2026, 9, 2), [28, 31]),
    (2027, 1, date(2026, 12, 30), date(2027, 1, 4), [1, 4]),
    (2028, 2, date(2028, 2, 28), date(2028, 3, 1), [28, 29]),
    (2026, 8, date(2026, 7, 1), date(2026, 7, 31), []),
    (2026, 8, date(2026, 9, 1), date(2026, 9, 30), []),
])
def test_absences_are_clipped_to_the_selected_month(year, month, start, end, days):
    plan = month_plan([absence(AbsenceType.VACATION, start, end)], year=year, month=month)
    assert [day.work_date for day in plan.days] == [date(year, month, day) for day in days]
    assert sum(day.net_work_minutes for day in plan.days) == len(days) * 480


def test_cancelled_foreign_and_other_absence_types_are_not_exported():
    records = [
        absence(AbsenceType.VACATION, date(2026, 8, 3), status=AbsenceStatus.CANCELLED),
        absence(AbsenceType.SICK, date(2026, 8, 4), status=AbsenceStatus.CANCELLED),
        absence(AbsenceType.VACATION, date(2026, 8, 5), person_id=2),
        *[absence(kind, date(2026, 8, 6))
          for kind in (AbsenceType.SCHOOL, AbsenceType.FREE, AbsenceType.OTHER)],
    ]
    assert month_plan(records).days == ()


def test_duplicate_vacation_dates_are_not_credited_twice():
    records = [
        absence(AbsenceType.VACATION, date(2026, 8, 3), date(2026, 8, 4)),
        absence(AbsenceType.VACATION, date(2026, 8, 4)),
    ]
    assert sum(day.net_work_minutes for day in month_plan(records).days) == 960


def test_vacation_credit_cannot_trigger_four_day_redistribution():
    records = [absence(AbsenceType.VACATION, date(2026, 6, 4))]
    entries = long_week_entries([1, 2, 3])
    before = [entry_snapshot(entry) for entry in entries]
    plan = month_plan(records, month=6, entries=entries)

    assert len(plan.days) == 4
    assert [day.net_work_minutes for day in plan.days] == [600, 600, 600, 480]
    assert not any(day.is_derived for day in plan.days)
    assert [entry_snapshot(entry) for entry in entries] == before


def test_month_totals_add_vacation_credit_without_changing_recorded_minutes():
    entries = [make_entry(1, date(2026, 8, 3), "06:00", "14:15", None)]
    records = [
        absence(AbsenceType.VACATION, date(2026, 8, 4), date(2026, 8, 5)),
        absence(AbsenceType.SICK, date(2026, 8, 6)),
    ]
    before = [entry_snapshot(entry) for entry in entries]
    single = build_payroll_month_xlsx(
        person=PERSON, year=2026, month=8, entries=entries, absences=records,
    )
    multi = build_payroll_months_xlsx([
        PayrollMonthSheet(PERSON, "Test", 2026, 8, entries, absences=records),
    ])

    assert single.plan == multi.plans[0]
    assert [entry_snapshot(entry) for entry in entries] == before
    assert [day.net_work_minutes for day in single.plan.days] == [495, 480, 480, 0]
    for content in (single.content, multi.content):
        with ZipFile(BytesIO(content)) as workbook:
            sheet = ET.fromstring(workbook.read("xl/worksheets/sheet1.xml"))
        assert float(cell_text(sheet, "E41")) * 24 == pytest.approx(24.25)
        assert float(cell_text(sheet, "D46")) * 24 == pytest.approx(160)
        assert cell_text(sheet, "D47") == "-135:45"
        assert cell_text(sheet, "D48") == "1"
        assert float(cell_text(sheet, "G48")) * 24 == pytest.approx(8)
        assert sheet.find('.//main:c[@r="E41"]/main:f', NS).text == "SUM(E10:E40)"
        assert cell_text(sheet, "H13") == "Urlaub"
        assert cell_text(sheet, "H14") == "Urlaub"
        assert cell_text(sheet, "H15") == "Krankheit"
        assert float(cell_text(sheet, "E15")) == 0
