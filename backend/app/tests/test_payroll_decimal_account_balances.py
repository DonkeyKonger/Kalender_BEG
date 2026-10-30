from io import BytesIO
from zipfile import ZipFile
import xml.etree.ElementTree as ET

import pytest

from app.models.person import Person
from app.services.payroll_month_xlsx_service import (
    PayrollMonthSheet, build_payroll_month_xlsx, build_payroll_months_xlsx,
)
from app.services.payroll_approved_workbook_merge import merge_approved_payroll_workbooks
from app.services.payroll_workbook_presentation import prepare_payroll_workbook_download
from app.tests.test_payroll_month_xlsx_service import NS, cell_number_format, cell_text


@pytest.mark.parametrize("opening,closing", [
    (6000, 5835), (15, 30), (45, 0), (-15, -90), (-6000, 6000),
    (None, None), (None, 0), (0, None), (1, -1),
])
def test_decimal_account_balances_preserve_minutes_blanks_and_sign(opening, closing):
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
                for ref, minutes in (("K50", opening), ("K51", closing)):
                    assert cell_number_format(sheet, styles, ref) == "0.00"
                    cell = sheet.find(f'.//main:c[@r="{ref}"]', NS)
                    if minutes is None:
                        assert not list(cell)
                    else:
                        assert cell.get("t") in {None, "n"}
                        assert float(cell_text(sheet, ref)) == pytest.approx(minutes / 60)
                for ref in ("D46", "D47", "G48"):
                    assert cell_text(sheet, ref) == cell_text(old, ref)


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
