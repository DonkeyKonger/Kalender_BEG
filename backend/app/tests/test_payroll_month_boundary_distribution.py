from datetime import date, time, timedelta
from io import BytesIO
from zipfile import ZipFile
import xml.etree.ElementTree as ET

import pytest

from app.models.absence import Absence
from app.models.enums import AbsenceStatus, AbsenceType
from app.services.payroll_month_xlsx_service import (
    PayrollMonthSheet,
    build_payroll_month_plan,
    build_payroll_month_xlsx,
    build_payroll_months_xlsx,
)
from app.tests.test_payroll_month_minutes import PERSON, entry, number


def boundary_entries(monday, minutes):
    return [entry(index + 1, monday + timedelta(days=index), start_time="06:00",
                  end_time=time((6 * 60 + value + 45) // 60, (value + 45) % 60),
                  break_minutes=45, work_minutes=value)
            for index, value in enumerate(minutes) if value is not None]


@pytest.mark.parametrize("monday,minutes,expected", [
    (date(2026, 9, 28), [600] * 4, {(2026, 9): [600] * 3, (2026, 10): [300, 300]}),
    (date(2026, 8, 31), [600] * 4, {(2026, 8): [600], (2026, 9): [480, 480, 480, 360]}),
    (date(2026, 6, 29), [600] * 4, {(2026, 6): [600] * 2, (2026, 7): [420, 420, 360]}),
    # Actual September/October attachment: 34 hours stay in September; 9:30
    # becomes Thursday 5:00 and Friday 4:30, not a five-day cross-month average.
    (date(2026, 9, 28), [720, 660, 660, 570], {(2026, 9): [720, 660, 660], (2026, 10): [300, 270]}),
    (date(2025, 12, 29), [600] * 4, {(2025, 12): [600] * 3, (2026, 1): [300, 300]}),
    # The only day in the next month has no recorded hours to redistribute.
    (date(2026, 12, 28), [600] * 4, {(2026, 12): [600] * 4, (2027, 1): []}),
    # Also retain the month's own hours if the missing day precedes the boundary.
    (date(2026, 9, 28), [600, 600, None, 600, 600], {(2026, 9): [420, 420, 360], (2026, 10): [600, 600]}),
])
def test_boundary_segments_preserve_their_own_hours_and_existing_rounding(monday, minutes, expected):
    entries = boundary_entries(monday, minutes)
    before = [dict(item.__dict__) for item in entries]
    for (year, month), daily_minutes in expected.items():
        plan = build_payroll_month_plan(person=PERSON, year=year, month=month, entries=entries)
        assert [day.net_work_minutes for day in plan.days] == daily_minutes
        assert sum(daily_minutes) == sum(item.work_minutes for item in entries
                                         if (item.work_date.year, item.work_date.month) == (year, month))
        assert all((day.work_date.year, day.work_date.month) == (year, month) for day in plan.days)
        for day in plan.days:
            if day.is_derived:
                assert day.work_date not in {item.work_date for item in entries}
                assert day.break_minutes == 45
                assert day.source_entry_ids == ()
                assert (day.end_time.hour * 60 + day.end_time.minute
                        - day.start_time.hour * 60 - day.start_time.minute) == day.net_work_minutes + 45
    assert [dict(item.__dict__) for item in entries] == before


@pytest.mark.parametrize("reason", ["absence", "holiday", "short_week", "incomplete_week", "five_days", "short_segment"])
def test_boundary_does_not_weaken_existing_eligibility_or_invent_hours(reason):
    minutes = [600] * 4
    if reason == "short_week":
        minutes[-1] = 345
    if reason == "incomplete_week":
        minutes[0] = None
    if reason == "five_days":
        minutes.append(60)
    if reason == "short_segment":
        minutes = [720, 720, 720, 30]
    entries = boundary_entries(date(2026, 9, 28), minutes)
    kwargs = {}
    if reason == "absence":
        kwargs["absences"] = [Absence(person_id=PERSON.id, absence_type=AbsenceType.FREE,
                                     start_date=date(2026, 10, 2), end_date=date(2026, 10, 2),
                                     status=AbsenceStatus.ACTIVE)]
    if reason == "holiday":
        kwargs["non_working_dates"] = {date(2026, 10, 2)}
    plan = build_payroll_month_plan(person=PERSON, year=2026, month=10, entries=entries, **kwargs)
    assert not any(day.is_derived for day in plan.days)
    assert [day.net_work_minutes for day in plan.days] == [item.work_minutes for item in entries if item.work_date.month == 10]


def test_single_and_combined_workbooks_write_the_same_boundary_days_and_totals():
    entries = boundary_entries(date(2026, 9, 28), [720, 660, 660, 570])
    for month, expected in [(9, {28: 720, 29: 660, 30: 660}), (10, {1: 300, 2: 270})]:
        single = build_payroll_month_xlsx(person=PERSON, year=2026, month=month, entries=entries)
        combined = build_payroll_months_xlsx([PayrollMonthSheet(PERSON, "Test", 2026, month, entries)])
        for content in (single.content, combined.content):
            with ZipFile(BytesIO(content)) as workbook:
                sheet = ET.fromstring(workbook.read("xl/worksheets/sheet1.xml"))
            assert number(sheet, "E41") * 1440 == pytest.approx(sum(expected.values()))
            for day, minutes in expected.items():
                assert number(sheet, f"E{day + 9}") * 1440 == pytest.approx(minutes)
