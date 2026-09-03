import calendar
import json
import xml.etree.ElementTree as ET
from datetime import date, time, timedelta
from io import BytesIO
from pathlib import Path
from zipfile import ZipFile

import pytest

from app.models.person import Person
from app.models.work_time_entry import WorkTimeEntry
from app.services.payroll_month_xlsx_service import (
    PayrollMonthSheet,
    build_payroll_month_plan,
    build_payroll_month_xlsx,
    build_payroll_months_xlsx,
)

CASES = json.loads((Path(__file__).parent / "fixtures/payroll_month_minutes.json").read_text())
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
PERSON = Person(id=1, display_name="Test Monteur", weekly_hours=40)


def entry(identifier, work_date, **values):
    values = dict(values)
    for field in ("start_time", "end_time", "payroll_corrected_start_time", "payroll_corrected_end_time"):
        if isinstance(values.get(field), str):
            values[field] = time.fromisoformat(values[field])
    return WorkTimeEntry(**{
        "id": identifier, "person_id": PERSON.id, "work_date": work_date,
        "work_minutes": 0, "travel_minutes": 0, "break_minutes": 0,
        "source": "manual", "status": "submitted", **values,
    })


def number(sheet, ref):
    cell = sheet.find(f'.//m:c[@r="{ref}"]/m:v', NS)
    return float(cell.text) if cell is not None else 0


@pytest.mark.parametrize("scenario", CASES, ids=lambda case: case["name"])
def test_export_matches_the_actual_screen_minutes_contract(scenario):
    entries = [entry(i, date(2026, 8, 3), **values)
               for i, values in enumerate(scenario["entries"], start=1)]
    result = build_payroll_month_xlsx(person=PERSON, year=2026, month=8, entries=entries)
    assert sum(day.net_work_minutes for day in result.plan.days) == scenario["expected_minutes"]
    with ZipFile(BytesIO(result.content)) as workbook:
        sheet = ET.fromstring(workbook.read("xl/worksheets/sheet1.xml"))
    assert number(sheet, "E41") * 1440 == pytest.approx(scenario["expected_minutes"])
    assert sum(number(sheet, f"E{row}") for row in range(10, 41)) * 1440 == pytest.approx(scenario["expected_minutes"])


def test_screenshot_weeks_preserve_recorded_hours_despite_conflicting_time_spans():
    # Recorded minutes from the screenshot; deliberately conflicting old clock spans.
    recorded = [705, 660, 705, 555, 735, 660, 645, 555]
    dates = [3, 4, 5, 6, 10, 11, 12, 13]
    entries = [entry(i, date(2026, 8, day), start_time="06:00", end_time="16:00",
                     break_minutes=60, work_minutes=minutes)
               for i, (day, minutes) in enumerate(zip(dates, recorded), start=1)]
    result = build_payroll_month_xlsx(person=PERSON, year=2026, month=8, entries=entries)
    assert [day.net_work_minutes for day in result.plan.days] == [525] * 5 + [519] * 5
    assert sum(day.net_work_minutes for day in result.plan.days) == 87 * 60
    assert sum(day.net_work_minutes for day in result.plan.days if day.work_date.isocalendar().week == 32) == 2625
    assert sum(day.net_work_minutes for day in result.plan.days if day.work_date.isocalendar().week == 33) == 2595


@pytest.mark.parametrize("year", [2026, 2027, 2028])
@pytest.mark.parametrize("month", range(1, 13))
def test_distribution_preserves_every_month_and_week_including_boundaries(year, month):
    first = date(year, month, 1)
    last = date(year, month, calendar.monthrange(year, month)[1])
    cursor = first - timedelta(days=first.weekday())
    end = last + timedelta(days=6 - last.weekday())
    entries = []
    while cursor <= end:
        if cursor.weekday() < 4:
            entries.append(entry(len(entries) + 1, cursor, start_time="06:00", end_time="16:00", work_minutes=615))
        cursor += timedelta(days=1)
    # Include weekend work, which must neither disappear nor be redistributed.
    weekend = next(first + timedelta(days=i) for i in range(7) if (first + timedelta(days=i)).weekday() == 5)
    entries.append(entry(len(entries) + 1, weekend, work_minutes=180))
    plan = build_payroll_month_plan(person=PERSON, year=year, month=month, entries=entries)
    in_month = [item for item in entries if first <= item.work_date <= last]
    assert sum(day.net_work_minutes for day in plan.days) == sum(item.work_minutes for item in in_month)
    for week in {item.work_date.isocalendar()[:2] for item in in_month}:
        assert sum(day.net_work_minutes for day in plan.days if day.work_date.isocalendar()[:2] == week) == sum(
            item.work_minutes for item in in_month if item.work_date.isocalendar()[:2] == week
        )


def test_hours_without_clock_times_keep_site_and_do_not_invent_times():
    item = entry(1, date(2026, 8, 3), work_minutes=480, note="Manuelle Baustelle: Material laden")
    result = build_payroll_month_xlsx(person=PERSON, year=2026, month=8, entries=[item])
    assert result.plan.days[0].start_time is None
    assert result.plan.days[0].end_time is None
    assert result.plan.days[0].site_place == "Material laden"
    with ZipFile(BytesIO(result.content)) as workbook:
        sheet = ET.fromstring(workbook.read("xl/worksheets/sheet1.xml"))
    for ref in ("B12", "C12"):
        assert len(sheet.find(f'.//m:c[@r="{ref}"]', NS)) == 0
    assert number(sheet, "E12") * 1440 == pytest.approx(480)


def test_distribution_without_clock_times_keeps_the_full_recorded_total():
    entries = [entry(day, date(2026, 8, day), work_minutes=600) for day in (3, 4, 5, 6)]
    plan = build_payroll_month_plan(person=PERSON, year=2026, month=8, entries=entries)
    assert len(plan.days) == 5
    assert all(day.start_time is None and day.end_time is None for day in plan.days)
    assert sum(day.net_work_minutes for day in plan.days) == 2400


def test_single_and_all_workers_export_use_identical_totals_and_do_not_mutate_sources():
    item = entry(1, date(2026, 8, 3), start_time="06:00", end_time="14:00", work_minutes=480,
                 payroll_corrected_work_minutes=540, travel_minutes=90)
    before = dict(item.__dict__)
    single = build_payroll_month_xlsx(person=PERSON, year=2026, month=8, entries=[item])
    all_workers = build_payroll_months_xlsx([PayrollMonthSheet(PERSON, "Test", 2026, 8, [item])])
    assert item.__dict__ == before
    for content in (single.content, all_workers.content):
        with ZipFile(BytesIO(content)) as workbook:
            sheet = ET.fromstring(workbook.read("xl/worksheets/sheet1.xml"))
        assert number(sheet, "E41") * 1440 == pytest.approx(630)
