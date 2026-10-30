from datetime import date
from copy import deepcopy
from io import BytesIO
from zipfile import ZipFile
import xml.etree.ElementTree as ET

import pytest

from app.models.person import Person
from app.services.payroll_month_xlsx_service import (
    PayrollMonthSheet,
    build_payroll_month_xlsx,
    build_payroll_months_xlsx,
)
from app.services.payroll_workbook_presentation import prepare_payroll_workbook_download
from app.tests.test_payroll_individual_month_download import approved_workers as approved_workers
from app.tests.test_payroll_month_minutes import entry
from app.tests.test_payroll_month_xlsx_service import NS, cell_number_format, cell_text


def assert_payroll_cell_preserved(before, after):
    """Compare content exactly except for the total's explicit unit conversion."""
    expected = deepcopy(before)
    formula = expected.find("main:f", NS)
    if expected.get("r") == "E41" and formula is not None:
        assert formula.text == "SUM(E10:E40)"
        formula.text = "SUM(E10:E40)*24"
        value = expected.find("main:v", NS)
        changed_value = after.find("main:v", NS)
        assert float(changed_value.text) == pytest.approx(float(value.text) * 24)
        value.text = changed_value.text
    elif expected.get("r") == "D47" and formula is not None:
        formula.text = formula.text.replace("E41*24-D46", "E41-D46")
    elif expected.get("r") in {"K50", "K51"} and list(expected):
        value = expected.find("main:v", NS)
        if value is not None:
            hours = float(value.text) * 24
        else:
            text = expected.find("main:is/main:t", NS).text
            whole, minutes = text.removeprefix("-").split(":")
            hours = -(int(whole) + int(minutes) / 60)
        assert after.get("t") in {None, "n"}
        assert after.find("main:f", NS) is None
        assert float(after.find("main:v", NS).text) == pytest.approx(hours)
        return
    assert ET.tostring(expected) == ET.tostring(after)


def assert_decimal_total(content, hours, sheet_index=1):
    with ZipFile(BytesIO(content)) as workbook:
        sheet = ET.fromstring(workbook.read(f"xl/worksheets/sheet{sheet_index}.xml"))
        styles = ET.fromstring(workbook.read("xl/styles.xml"))
    assert float(cell_text(sheet, "E41")) == pytest.approx(hours)
    assert cell_number_format(sheet, styles, "E41") == "0.00"
    assert sheet.find('.//main:c[@r="E41"]/main:f', NS).text == "SUM(E10:E40)*24"
    assert cell_number_format(sheet, styles, "E10") == "[h]:mm"
    return sheet


@pytest.mark.parametrize("minutes", [0, 15, 30, 45, 10200, 10215, 10230, 10245])
def test_decimal_total_preserves_quarters_in_both_exports(minutes):
    person = Person(id=1, display_name="Test", weekly_hours=40)
    days = [date(2026, 10, day) for day in range(1, 32)
            if date(2026, 10, day).weekday() < 5]
    records = [entry(i + 1, day, work_minutes=min(480, minutes - i * 480))
               for i, day in enumerate(days) if minutes > i * 480]
    single = build_payroll_month_xlsx(person=person, year=2026, month=10, entries=records)
    combined = build_payroll_months_xlsx([
        PayrollMonthSheet(person, "A", 2026, 10, records),
        PayrollMonthSheet(person, "B", 2026, 10, records),
    ])
    for content, index in [(single.content, 1), (combined.content, 1), (combined.content, 2)]:
        sheet = assert_decimal_total(prepare_payroll_workbook_download(content), minutes / 60, index)
        daily = sum(float(cell_text(sheet, f"E{row}") or 0) for row in range(10, 41))
        assert daily * 1440 == pytest.approx(minutes)
        assert "E41-D46" in sheet.find('.//main:c[@r="D47"]/main:f', NS).text
    legacy = single.content
    corrected = prepare_payroll_workbook_download(legacy)
    sheet = assert_decimal_total(corrected, minutes / 60)
    assert "E41-D46" in sheet.find('.//main:c[@r="D47"]/main:f', NS).text
    with ZipFile(BytesIO(legacy)) as before:
        old = ET.fromstring(before.read("xl/worksheets/sheet1.xml"))
    for ref in ("D46", "D47", "G48", "K50", "K51"):
        assert cell_text(sheet, ref) == cell_text(old, ref)
    assert prepare_payroll_workbook_download(corrected) == corrected


def test_existing_approved_downloads_convert_without_replacing_stored_artifact(approved_workers):
    import hashlib

    case = approved_workers
    artifact = case.artifacts[0]
    legacy = case.workbooks[0]
    artifact.content = legacy
    artifact.byte_size = len(legacy)
    artifact.content_sha256 = hashlib.sha256(legacy).hexdigest()
    case.db.commit()
    with ZipFile(BytesIO(legacy)) as package:
        old = ET.fromstring(package.read("xl/worksheets/sheet1.xml"))
    expected = float(cell_text(old, "E41")) * 24
    assert_decimal_total(case.service.worker_export(person_id=artifact.person_id, **case.args), expected)
    assert_decimal_total(case.service.all_workers_export(**case.args), expected)
    assert artifact.content == legacy
    assert artifact.content_sha256 == hashlib.sha256(legacy).hexdigest()
    assert not case.db.new and not case.db.dirty and not case.db.deleted
