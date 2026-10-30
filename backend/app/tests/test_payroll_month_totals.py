from datetime import date
from io import BytesIO
from zipfile import ZipFile
import xml.etree.ElementTree as ET

import pytest

from app.models.enums import AbsenceType
from app.models.person import Person
from app.services.payroll_month_xlsx_service import (
    build_payroll_month_xlsx,
    calculate_payroll_month_totals,
)
from app.tests.test_payroll_month_absences import absence
from app.tests.test_payroll_month_minutes import entry
from app.tests.test_payroll_month_xlsx_service import NS, cell_text


@pytest.mark.parametrize("weekly_hours,absence_type,holidays", [
    (40, None, ()), (37.5, AbsenceType.VACATION, ()),
    (40, AbsenceType.SICK, (date(2026, 8, 6),)), (None, None, ()),
])
def test_reusable_month_totals_match_normal_excel_without_day_plans(weekly_hours, absence_type, holidays):
    person = Person(id=1, display_name="Test", weekly_hours=weekly_hours)
    records = [absence(absence_type, date(2026, 8, 7))] if absence_type else []
    entries = [entry(i, date(2026, 8, day), work_minutes=540) for i, day in enumerate((3, 4, 5, 6), 1)]
    original = [(item.work_date, item.work_minutes) for item in entries]
    result = build_payroll_month_xlsx(person=person, year=2026, month=8, entries=entries,
                                     absences=records, non_working_dates=holidays)
    totals = calculate_payroll_month_totals(person=person, plan=result.plan, year=2026,
                                           month=8, non_working_dates=holidays)
    with ZipFile(BytesIO(result.content)) as workbook:
        sheet = ET.fromstring(workbook.read("xl/worksheets/sheet1.xml"))
    assert float(cell_text(sheet, "E41")) * 1440 == pytest.approx(totals.total_minutes)
    assert int(cell_text(sheet, "D48")) == totals.sick_day_count
    assert float(cell_text(sheet, "G48")) * 1440 == pytest.approx(totals.sick_minutes)
    if weekly_hours is None:
        assert totals.normal_minutes is None
        assert totals.overtime_minutes is None
        assert cell_text(sheet, "D46") == cell_text(sheet, "D47") == "–"
    else:
        assert float(cell_text(sheet, "D46")) * 60 == pytest.approx(totals.normal_minutes)
        assert totals.overtime_minutes == totals.total_minutes - totals.normal_minutes
        assert cell_text(sheet, "D47") == f"-{abs(totals.overtime_minutes) // 60}:{abs(totals.overtime_minutes) % 60:02d}"
    assert [(item.work_date, item.work_minutes) for item in entries] == original


@pytest.mark.parametrize("actual_minutes,overtime_minutes", [
    (10200, -240), (10230, -210), (10440, 0), (10560, 120),
])
def test_actual_hours_use_fixed_normal_hours_for_excel_and_month_movement(
    actual_minutes, overtime_minutes,
):
    person = Person(id=1, display_name="Test", weekly_hours=40)
    days = [date(2026, 8, day) for day in range(1, 32) if date(2026, 8, day).weekday() < 5]
    extra_minutes = actual_minutes - len(days) * 480
    entries = [entry(i, day, work_minutes=480 + (extra_minutes if i == 1 else 0))
               for i, day in enumerate(days, 1)]
    result = build_payroll_month_xlsx(person=person, year=2026, month=8, entries=entries)
    totals = calculate_payroll_month_totals(person=person, plan=result.plan, year=2026, month=8,
                                           non_working_dates=())
    assert (totals.total_minutes, totals.normal_minutes, totals.overtime_minutes) == (
        actual_minutes, 10440, overtime_minutes,
    )
    with ZipFile(BytesIO(result.content)) as workbook:
        sheet = ET.fromstring(workbook.read("xl/worksheets/sheet1.xml"))
    if overtime_minutes < 0:
        hours, minutes = divmod(-overtime_minutes, 60)
        assert cell_text(sheet, "D47") == f"-{hours}:{minutes:02d}"
    else:
        assert float(cell_text(sheet, "D47")) * 1440 == pytest.approx(overtime_minutes)
    assert sheet.find('.//main:c[@r="D46"]/main:f', NS).text == "ROUND((4.35*40-G48*24)*4,0)/4"
