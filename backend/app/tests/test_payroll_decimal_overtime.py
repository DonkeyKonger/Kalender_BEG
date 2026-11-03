from io import BytesIO
from zipfile import ZipFile
import xml.etree.ElementTree as ET

import pytest

from app.models.person import Person
from app.services.payroll_month_xlsx_service import (
    PayrollMonthSheet, build_payroll_month_xlsx, build_payroll_months_xlsx,
)
from app.services.payroll_workbook_presentation import (
    prepare_payroll_workbook_download, _decimal_overtime_hours,
)
from app.tests.test_payroll_month_xlsx_service import NS, cell_number_format, cell_text


@pytest.mark.parametrize("minutes,expected", [
    (0, 0), (15, .25), (30, .5), (45, .75), (810, 13.5),
    (7, 0), (8, .25), (22, .25), (23, .5), (37, .5), (38, .75),
    (52, .75), (53, 1), (None, None),
])
def test_retained_payouts_become_right_aligned_decimal_quarters(minutes, expected):
    person = Person(id=1, display_name="Test", weekly_hours=40)
    settlement = {"payout_minutes": minutes}
    original = build_payroll_month_xlsx(
        person=person, year=2026, month=10, entries=[], account_settlement=settlement,
    ).content
    combined = build_payroll_months_xlsx([
        PayrollMonthSheet(person, name, 2026, 10, [], account_settlement=settlement)
        for name in ("A", "B")
    ]).content
    for content, indices in ((original, (1,)), (combined, (1, 2))):
        corrected = prepare_payroll_workbook_download(content)
        assert prepare_payroll_workbook_download(corrected) == corrected
        with ZipFile(BytesIO(corrected)) as package:
            styles = ET.fromstring(package.read("xl/styles.xml"))
            for index in indices:
                sheet = ET.fromstring(package.read(f"xl/worksheets/sheet{index}.xml"))
                cell = sheet.find('.//main:c[@r="D47"]', NS)
                assert cell_number_format(sheet, styles, "D47") == "0.00"
                style = styles.find("main:cellXfs", NS)[int(cell.get("s"))]
                assert style.find("main:alignment", NS).get("horizontal") == "right"
                assert cell.find("main:f", NS) is None
                if expected is None:
                    assert cell_text(sheet, "D47") == "–"
                else:
                    assert cell.get("t") in {None, "n"}
                    assert float(cell_text(sheet, "D47")) == expected


@pytest.mark.parametrize("cached,cell_type,expected", [
    ("-1:07", "str", -1), ("-1:08", "str", -1.25),
    (str(68 / 1440), "n", 1.25), ("0", "n", 0),
])
def test_generated_formula_keeps_numeric_signed_cache_and_rounds_after_recalculation(
    cached, cell_type, expected,
):
    content = build_payroll_month_xlsx(
        person=Person(id=1, display_name="Test", weekly_hours=40),
        year=2026, month=10, entries=[],
    ).content
    with ZipFile(BytesIO(content)) as package:
        sheet = ET.fromstring(package.read("xl/worksheets/sheet1.xml"))
        styles = ET.fromstring(package.read("xl/styles.xml"))
    cell = sheet.find('.//main:c[@r="D47"]', NS)
    cell.set("t", cell_type)
    cell.find("main:v", NS).text = cached
    assert _decimal_overtime_hours(sheet, styles)
    assert float(cell_text(sheet, "D47")) == expected
    assert cell.get("t") in {None, "n"}
    assert cell.find("main:f", NS).text == 'IF(ISNUMBER(D46),ROUND((E41*24-D46)*4,0)/4,"–")'
    before = ET.tostring(cell)
    cell.find("main:f", NS).text = "SUM(A1:A5)"
    custom = ET.tostring(cell)
    assert not _decimal_overtime_hours(sheet, styles)
    assert ET.tostring(cell) == custom
    assert before != custom
