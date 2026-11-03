from io import BytesIO
import xml.etree.ElementTree as ET
from zipfile import ZipFile, ZIP_DEFLATED

import pytest

from app.models.person import Person
from app.services.payroll_month_xlsx_service import (
    build_payroll_month_xlsx, _set_cell_number, _set_cell_string,
)
from app.services.payroll_workbook_presentation import prepare_payroll_workbook_download
from app.tests.test_payroll_month_xlsx_service import NS, cell_text, cell_number_format


@pytest.fixture
def daily_workbook():
    return build_payroll_month_xlsx(
        person=Person(id=1, display_name="Test", weekly_hours=40),
        year=2026, month=10, entries=[], account_settlement={"payout_minutes": 810},
    ).content


def with_day_values(content, work_minutes, break_minutes):
    output = BytesIO()
    with ZipFile(BytesIO(content)) as source, ZipFile(output, "w", ZIP_DEFLATED) as target:
        sheet = ET.fromstring(source.read("xl/worksheets/sheet1.xml"))
        for ref, minutes in (("E10", work_minutes), ("E11", 390), ("E21", 0)):
            _set_cell_number(sheet, ref, minutes / 1440)
        _set_cell_string(sheet, "D10", f"{break_minutes // 60}:{break_minutes % 60:02d}")
        _set_cell_string(sheet, "D11", "0:00")
        _set_cell_string(sheet, "B10", "05:45")
        _set_cell_string(sheet, "C10", "15:15")
        for item in source.infolist():
            target.writestr(item, ET.tostring(sheet) if item.filename == "xl/worksheets/sheet1.xml"
                            else source.read(item.filename))
    return output.getvalue()


@pytest.mark.parametrize("work,rest,expected_work,expected_rest", [
    (540, 30, 9, .5), (390, 0, 6.5, 0), (555, 45, 9.25, .75),
    (562, 7, 9.25, 0), (563, 8, 9.5, .25),
    (577, 22, 9.5, .25), (578, 23, 9.75, .5),
    (592, 37, 9.75, .5), (593, 38, 10, .75), (600, 53, 10, 1),
])
def test_daily_hours_and_breaks_are_numeric_quarters_with_consistent_sum(
    daily_workbook, work, rest, expected_work, expected_rest,
):
    original = with_day_values(daily_workbook, work, rest)
    corrected = prepare_payroll_workbook_download(original)
    assert prepare_payroll_workbook_download(corrected) == corrected
    with ZipFile(BytesIO(corrected)) as package:
        sheet = ET.fromstring(package.read("xl/worksheets/sheet1.xml"))
        styles = ET.fromstring(package.read("xl/styles.xml"))
    for ref, expected in (("D10", expected_rest), ("E10", expected_work),
                          ("D11", 0), ("E11", 6.5), ("E21", 0)):
        cell = sheet.find(f'.//main:c[@r="{ref}"]', NS)
        assert cell.get("t") in {None, "n"}
        assert float(cell_text(sheet, ref)) == expected
        assert cell_number_format(sheet, styles, ref) == "0.00"
        style = styles.find("main:cellXfs", NS)[int(cell.get("s"))]
        assert style.find("main:alignment", NS).get("horizontal") == "right"
    assert cell_text(sheet, "D21") == cell_text(sheet, "D12") == cell_text(sheet, "E12") == ""
    assert cell_text(sheet, "B10") == "05:45" and cell_text(sheet, "C10") == "15:15"
    assert sheet.find('.//main:c[@r="E41"]/main:f', NS).text == "SUM(E10:E40)"
    assert float(cell_text(sheet, "E41")) == expected_work + 6.5
    assert float(cell_text(sheet, "D47")) == 13.5  # Approved payout remains authoritative.


@pytest.mark.parametrize("minutes,expected_total", [(562, 15.75), (563, 16)])
def test_generated_overtime_uses_the_sum_of_rounded_days(minutes, expected_total):
    original = build_payroll_month_xlsx(
        person=Person(id=1, display_name="Test", weekly_hours=40),
        year=2026, month=10, entries=[],
    ).content
    corrected = prepare_payroll_workbook_download(with_day_values(original, minutes, 30))
    assert prepare_payroll_workbook_download(corrected) == corrected
    with ZipFile(BytesIO(corrected)) as package:
        sheet = ET.fromstring(package.read("xl/worksheets/sheet1.xml"))
    assert float(cell_text(sheet, "E41")) == expected_total
    assert float(cell_text(sheet, "D46")) == 174
    assert float(cell_text(sheet, "D47")) == expected_total - 174
    assert sheet.find('.//main:c[@r="D47"]/main:f', NS).text == (
        'IF(ISNUMBER(D46),ROUND((E41-D46)*4,0)/4,"–")'
    )
