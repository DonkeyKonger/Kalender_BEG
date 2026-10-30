from io import BytesIO
import re
import xml.etree.ElementTree as ET
from zipfile import ZIP_DEFLATED, ZipFile

import pytest

from app.tests.test_payroll_decimal_total_hours import assert_payroll_cell_preserved

from app.services.payroll_approved_workbook_merge import merge_approved_payroll_workbooks
from app.services.payroll_month_xlsx_service import (
    PayrollMonthSheet, _preserve_ignorable_namespaces,
    build_payroll_month_xlsx, build_payroll_months_xlsx,
)
from app.services.payroll_workbook_presentation import prepare_payroll_workbook_download
from app.tests.test_payroll_month_xlsx_service import NS, PERSON


def assert_single_page_per_sheet(content):
    with ZipFile(BytesIO(content)) as book:
        workbook = ET.fromstring(book.read("xl/workbook.xml"))
        names = workbook.findall("main:definedNames/main:definedName", NS)
        areas = [item for item in names if item.get("name") == "_xlnm.Print_Area"]
        sheets = workbook.findall("main:sheets/main:sheet", NS)
        assert len(areas) == len(sheets)
        for index, item in enumerate(sheets):
            escaped_name = item.get("name").replace("'", "''")
            area = next(area for area in areas if area.get("localSheetId") == str(index))
            assert area.text == f"'{escaped_name}'!$A$1:$L$52"
            sheet = ET.fromstring(book.read(f"xl/worksheets/sheet{index + 1}.xml"))
            assert sheet.find("main:sheetPr/main:pageSetUpPr", NS).get("fitToPage") == "1"
            setup = sheet.find("main:pageSetup", NS)
            assert setup.get("paperSize") == "9"  # A4
            assert setup.get("orientation") == "portrait"
            assert setup.get("fitToWidth") == setup.get("fitToHeight") == "1"
            assert setup.get("usePrinterDefaults") == "0"
            assert "scale" not in setup.attrib
            assert sheet.find("main:rowBreaks", NS) is None
            assert sheet.find("main:colBreaks", NS) is None
            # Keep the footer and all 31 day rows in the printed form.
            assert sheet.find('.//main:c[@r="A40"]', NS) is not None
            assert sheet.find('.//main:c[@r="K52"]', NS) is not None


@pytest.mark.parametrize("month", [2, 9, 12])
def test_new_month_exports_fit_complete_form_on_one_a4_page(month):
    result = build_payroll_month_xlsx(person=PERSON, year=2026, month=month, entries=[])
    assert_single_page_per_sheet(result.content)


def test_each_sheet_in_multi_export_has_its_own_escaped_print_area():
    result = build_payroll_months_xlsx([
        PayrollMonthSheet(person=PERSON, sheet_name=name, year=2026, month=9, entries=[])
        for name in ["O'Brien & Söhne", "Müller", "Müller"]
    ])
    assert_single_page_per_sheet(result.content)
    assert_single_page_per_sheet(prepare_payroll_workbook_download(result.content))


def previous_print_layout(content, *, custom_name=False):
    """A retained export with printer scaling, extra cells and manual page breaks."""
    output = BytesIO()
    with ZipFile(BytesIO(content)) as source, ZipFile(output, "w", ZIP_DEFLATED) as target:
        for item in source.infolist():
            payload = source.read(item.filename)
            if item.filename == "xl/workbook.xml":
                text = payload.decode()
                text = re.sub(r"<definedNames.*?</definedNames>", "", text, flags=re.DOTALL)
                text = text.replace("</sheets>", '</sheets><definedNames>'
                    '<definedName name="OfficeNote">Tabelle1!$I$46</definedName>'
                    '<definedName name="_xlnm.Print_Area" localSheetId="0">'
                    'Tabelle1!$A$1:$O$200</definedName></definedNames>')
                if not custom_name:
                    text = text.replace('<definedName name="OfficeNote">Tabelle1!$I$46</definedName>', "")
                payload = text.encode()
            elif item.filename == "xl/worksheets/sheet1.xml":
                sheet = ET.fromstring(payload)
                sheet.remove(sheet.find("main:sheetPr", NS))
                setup = sheet.find("main:pageSetup", NS)
                setup.attrib.clear()
                setup.attrib.update(scale="100", paperSize="1", fitToHeight="0")
                for kind in ("rowBreaks", "colBreaks"):
                    breaks = ET.SubElement(sheet, f"{{{NS['main']}}}{kind}", count="1", manualBreakCount="1")
                    ET.SubElement(breaks, f"{{{NS['main']}}}brk", id="40", min="0", max="16383", man="1")
                payload = _preserve_ignorable_namespaces(ET.tostring(sheet))
            target.writestr(item, payload)
    return output.getvalue()


def test_retained_print_layout_changes_without_changing_payroll_or_other_parts():
    original = previous_print_layout(build_payroll_month_xlsx(
        person=PERSON, year=2026, month=9, entries=[],
        opening_balance_minutes=60, closing_balance_minutes=120,
    ).content, custom_name=True)
    corrected = prepare_payroll_workbook_download(original)
    assert_single_page_per_sheet(corrected)
    assert prepare_payroll_workbook_download(corrected) == corrected
    with ZipFile(BytesIO(original)) as before, ZipFile(BytesIO(corrected)) as after:
        old_sheet = ET.fromstring(before.read("xl/worksheets/sheet1.xml"))
        new_sheet = ET.fromstring(after.read("xl/worksheets/sheet1.xml"))
        for cell in old_sheet.findall(".//main:c", NS):
            new_cell = new_sheet.find(f'.//main:c[@r="{cell.get("r")}"]', NS)
            cell.attrib.pop("s", None)
            new_cell.attrib.pop("s", None)
            assert_payroll_cell_preserved(cell, new_cell)
        assert ET.tostring(old_sheet.find("main:pageMargins", NS)) == ET.tostring(
            new_sheet.find("main:pageMargins", NS)
        )
        for path in before.namelist():
            if path not in {"xl/workbook.xml", "xl/styles.xml", "xl/worksheets/sheet1.xml"}:
                assert before.read(path) == after.read(path)
        workbook = ET.fromstring(after.read("xl/workbook.xml"))
        assert workbook.find('main:definedNames/main:definedName[@name="OfficeNote"]', NS).text == 'Tabelle1!$I$46'


def test_merged_approved_sheets_rebind_print_areas_to_their_final_names():
    original = build_payroll_month_xlsx(person=PERSON, year=2026, month=9, entries=[]).content
    prepared = prepare_payroll_workbook_download(original)
    retained = prepare_payroll_workbook_download(previous_print_layout(original))
    combined = merge_approved_payroll_workbooks([
        ("Bau O'Brien", retained), ("Bau O'Brien", prepared),
    ])
    assert_single_page_per_sheet(combined)
