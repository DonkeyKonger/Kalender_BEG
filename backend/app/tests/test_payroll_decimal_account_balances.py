from io import BytesIO
from zipfile import ZipFile
import xml.etree.ElementTree as ET

import pytest

from app.models.person import Person
from app.services.payroll_month_xlsx_service import (
    PayrollMonthSheet, build_payroll_month_xlsx, build_payroll_months_xlsx, _set_cell_number,
)
from app.services.payroll_approved_workbook_merge import merge_approved_payroll_workbooks
from app.services.payroll_workbook_presentation import (
    prepare_payroll_workbook_download, _decimal_account_balance,
)
from app.tests.test_payroll_month_xlsx_service import NS, cell_number_format, cell_text


@pytest.mark.parametrize("opening,closing,expected_opening,expected_closing", [
    (6000, 5835, 100, 97.25), (15, 30, .25, .5), (45, 0, .75, 0),
    (-15, -90, -.25, -1.5), (-6000, 6000, -100, 100),
    (None, None, None, None), (None, 0, None, 0), (0, None, 0, None),
    (1, -1, 0, 0), (7, 8, 0, .25), (22, 23, .25, .5),
    (37, 38, .5, .75), (52, 53, .75, 1),
    (-7, -8, 0, -.25), (-22, -23, -.25, -.5),
    (5380, 5215, 89.75, 87), (-5380, -5215, -89.75, -87),
])
def test_decimal_account_balances_round_to_quarters_and_preserve_blanks(
    opening, closing, expected_opening, expected_closing,
):
    person = Person(id=1, display_name="Test", weekly_hours=40)
    original = build_payroll_month_xlsx(
        person=person, year=2026, month=10, entries=[],
        opening_balance_minutes=opening, closing_balance_minutes=closing,
    ).content
    combined = build_payroll_months_xlsx([
        PayrollMonthSheet(person, name, 2026, 10, [],
                          opening_balance_minutes=opening, closing_balance_minutes=closing)
        for name in ("A", "B")
    ]).content
    for content, indices in ((original, (1,)), (combined, (1, 2))):
        corrected = prepare_payroll_workbook_download(content)
        assert prepare_payroll_workbook_download(corrected) == corrected
        with ZipFile(BytesIO(corrected)) as package, ZipFile(BytesIO(content)) as source:
            styles = ET.fromstring(package.read("xl/styles.xml"))
            for index in indices:
                path = f"xl/worksheets/sheet{index}.xml"
                sheet = ET.fromstring(package.read(path))
                old = ET.fromstring(source.read(path))
                for ref, expected in (("K50", expected_opening), ("K51", expected_closing)):
                    assert cell_number_format(sheet, styles, ref) == "0.00"
                    cell = sheet.find(f'.//main:c[@r="{ref}"]', NS)
                    if expected is None:
                        assert not list(cell)
                    else:
                        assert cell.get("t") in {None, "n"}
                        assert float(cell_text(sheet, ref)) == expected
                for ref in ("D46", "D47", "G48"):
                    assert cell_text(sheet, ref) == cell_text(old, ref)


@pytest.mark.parametrize("hours,expected", [
    (89.67, 89.75), (86.92, 87), (1.1249, 1), (1.125, 1.25),
    (-1.1249, -1), (-1.125, -1.25), (0, 0),
])
def test_existing_decimal_balances_round_half_away_from_zero_once(hours, expected):
    original = build_payroll_month_xlsx(
        person=Person(id=1, display_name="Test", weekly_hours=40),
        year=2026, month=10, entries=[], opening_balance_minutes=0,
    ).content
    with ZipFile(BytesIO(prepare_payroll_workbook_download(original))) as package:
        sheet = ET.fromstring(package.read("xl/worksheets/sheet1.xml"))
        styles = ET.fromstring(package.read("xl/styles.xml"))
    _set_cell_number(sheet, "K50", hours)
    assert _decimal_account_balance(sheet, styles, "K50")
    assert float(cell_text(sheet, "K50")) == expected
    first = ET.tostring(sheet)
    assert _decimal_account_balance(sheet, styles, "K50")
    assert ET.tostring(sheet) == first


def test_mixed_positive_negative_and_blank_balances_still_merge():
    person = Person(id=1, display_name="Test", weekly_hours=40)
    books = []
    for name, opening, closing in (("A", 6000, 5835), ("B", -15, -90), ("C", None, None)):
        original = build_payroll_month_xlsx(
            person=person, year=2026, month=10, entries=[],
            opening_balance_minutes=opening, closing_balance_minutes=closing,
        ).content
        books.append((name, prepare_payroll_workbook_download(original)))
    combined = merge_approved_payroll_workbooks(books)
    with ZipFile(BytesIO(combined)) as package:
        for index, (_, content) in enumerate(books, 1):
            with ZipFile(BytesIO(content)) as single:
                assert package.read(f"xl/worksheets/sheet{index}.xml") == single.read("xl/worksheets/sheet1.xml")
