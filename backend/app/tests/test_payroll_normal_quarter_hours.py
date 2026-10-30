from datetime import date
from decimal import Decimal
from io import BytesIO
from zipfile import ZipFile
import xml.etree.ElementTree as ET

import pytest

from app.models.enums import AbsenceType
from app.models.person import Person
from app.services import payroll_month_xlsx_service as xlsx
from app.tests.test_payroll_month_absences import absence
from app.tests.test_payroll_month_xlsx_service import NS, cell_text


@pytest.mark.parametrize("weekly_hours, normal_hours", [
    (40, 174), (37.5, 163.25), (38.75, 168.5), (50, 217.5), (0, 0),
])
def test_normal_hours_are_numeric_decimal_quarters_and_match_account_totals(
    weekly_hours, normal_hours,
):
    person = Person(id=1, display_name="Test", weekly_hours=weekly_hours)
    result = xlsx.build_payroll_month_xlsx(person=person, year=2026, month=9, entries=[])
    totals = xlsx.calculate_payroll_month_totals(
        person=person, plan=result.plan, year=2026, month=9, non_working_dates=(),
    )
    assert totals.normal_minutes == normal_hours * 60
    assert totals.overtime_minutes == -normal_hours * 60
    with ZipFile(BytesIO(result.content)) as package:
        sheet = ET.fromstring(package.read("xl/worksheets/sheet1.xml"))
        styles = ET.fromstring(package.read("xl/styles.xml"))
    cell = sheet.find('.//main:c[@r="D46"]', NS)
    assert cell.get("t") is None
    assert float(cell_text(sheet, "D46")) == normal_hours
    style = styles.find("main:cellXfs", NS)[int(cell.get("s"))]
    assert style.get("numFmtId") == "2"  # Excel's built-in 0.00 number format.
    assert "E41*24-D46" in sheet.find('.//main:c[@r="D47"]/main:f', NS).text


@pytest.mark.parametrize("raw_hours, rounded_hours", [
    (1.1249, 1), (1.125, 1.25), (1.1251, 1.25),
    (1.3749, 1.25), (1.375, 1.5),
    (1.6249, 1.5), (1.625, 1.75),
    (1.8749, 1.75), (1.875, 2),
])
def test_normal_hours_round_raw_quarters_without_rounding_minutes_first(
    monkeypatch, raw_hours, rounded_hours,
):
    monkeypatch.setattr(xlsx, "PAYROLL_MONTH_WEEK_FACTOR", Decimal("1"))
    person = Person(id=1, display_name="Test", weekly_hours=raw_hours)
    result = xlsx.build_payroll_month_xlsx(person=person, year=2026, month=9, entries=[])
    totals = xlsx.calculate_payroll_month_totals(
        person=person, plan=result.plan, year=2026, month=9, non_working_dates=(),
    )
    assert totals.normal_minutes == rounded_hours * 60


def test_negative_normal_hours_round_half_away_from_zero_after_sickness(monkeypatch):
    monkeypatch.setattr(xlsx, "PAYROLL_MONTH_WEEK_FACTOR", Decimal("1"))
    person = Person(id=1, display_name="Test", weekly_hours=7.875)
    result = xlsx.build_payroll_month_xlsx(
        person=person, year=2026, month=9, entries=[],
        absences=[absence(AbsenceType.SICK, date(2026, 9, 1))],
    )
    totals = xlsx.calculate_payroll_month_totals(
        person=person, plan=result.plan, year=2026, month=9, non_working_dates=(),
    )
    assert totals.sick_minutes == 480
    assert totals.normal_minutes == -15
    assert totals.overtime_minutes == 15


def test_combined_export_keeps_decimal_normal_hours_and_duration_cells_separate():
    workers = [Person(id=1, display_name="A", weekly_hours=40),
               Person(id=2, display_name="B", weekly_hours=38.75)]
    result = xlsx.build_payroll_months_xlsx([
        xlsx.PayrollMonthSheet(person, person.display_name, 2026, 9, []) for person in workers
    ])
    with ZipFile(BytesIO(result.content)) as package:
        styles = ET.fromstring(package.read("xl/styles.xml"))
        for index, expected in ((1, 174.0), (2, 168.5)):
            sheet = ET.fromstring(package.read(f"xl/worksheets/sheet{index}.xml"))
            assert float(cell_text(sheet, "D46")) == expected
            cell = sheet.find('.//main:c[@r="D46"]', NS)
            assert styles.find("main:cellXfs", NS)[int(cell.get("s"))].get("numFmtId") == "2"
            for ref in ("E41", "D47", "G48", "K50", "K51"):
                cell = sheet.find(f'.//main:c[@r="{ref}"]', NS)
                style = styles.find("main:cellXfs", NS)[int(cell.get("s"))]
                fmt = styles.find(f'main:numFmts/main:numFmt[@numFmtId="{style.get("numFmtId")}"]', NS)
                assert fmt.get("formatCode") == "[h]:mm"
