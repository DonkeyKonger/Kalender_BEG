"""Explicit, printer-independent page layout for the monthly payroll form."""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from collections.abc import Collection


_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
PAYROLL_PRINT_AREA = "$A$1:$L$52"


def _tag(name: str) -> str:
    return f"{{{_NS}}}{name}"


def configure_payroll_print_sheet(sheet: ET.Element) -> None:
    # Excel needs both the fit-to-page switch and the page count constraints.
    properties = sheet.find(_tag("sheetPr"))
    if properties is None:
        properties = ET.Element(_tag("sheetPr"))
        sheet.insert(0, properties)
    setup_properties = properties.find(_tag("pageSetUpPr"))
    if setup_properties is None:
        setup_properties = ET.SubElement(properties, _tag("pageSetUpPr"))
    setup_properties.set("fitToPage", "1")
    setup = sheet.find(_tag("pageSetup"))
    if setup is None:
        setup = ET.Element(_tag("pageSetup"))
        margins = sheet.find(_tag("pageMargins"))
        sheet.insert(list(sheet).index(margins) + 1, setup)
    setup.attrib.update(
        paperSize="9", orientation="portrait", fitToWidth="1", fitToHeight="1",
        usePrinterDefaults="0",
    )
    for attribute in ("scale", "paperWidth", "paperHeight"):
        setup.attrib.pop(attribute, None)
    for attribute in ("horizontalDpi", "verticalDpi"):
        if setup.get(attribute) == "0":
            setup.attrib.pop(attribute)
    for name in ("rowBreaks", "colBreaks"):
        for breaks in sheet.findall(_tag(name)):
            sheet.remove(breaks)


def configure_payroll_print_areas(
    workbook_xml: bytes, sheet_indices: Collection[int] | None = None,
) -> bytes:
    """Scope the form's print area to each sheet, including renamed merged sheets.

    Replace only definedNames in the original XML, preserving Excel's workbook
    extension namespaces and metadata verbatim.
    """
    workbook = ET.fromstring(workbook_xml)
    sheets = workbook.findall(f"{_tag('sheets')}/{_tag('sheet')}")
    selected = set(range(len(sheets))) if sheet_indices is None else set(sheet_indices)
    if not selected:
        return workbook_xml
    definitions = workbook.find(_tag("definedNames"))
    if definitions is None:
        definitions = ET.Element(_tag("definedNames"))
    selected_ids = {str(index) for index in selected}
    for definition in list(definitions):
        if (
            definition.get("name") == "_xlnm.Print_Area"
            and definition.get("localSheetId") in selected_ids
        ):
            definitions.remove(definition)
    for index in sorted(selected):
        name = sheets[index].get("name", "").replace("'", "''")
        definition = ET.SubElement(
            definitions, _tag("definedName"), name="_xlnm.Print_Area", localSheetId=str(index),
        )
        definition.text = f"'{name}'!{PAYROLL_PRINT_AREA}"
    serialized = ET.tostring(definitions, encoding="unicode")
    text = workbook_xml.decode("utf-8")
    pattern = r"<definedNames(?:\s[^>]*)?>.*?</definedNames>|<definedNames(?:\s[^>]*)?/>"
    if re.search(pattern, text, flags=re.DOTALL):
        text = re.sub(pattern, lambda _match: serialized, text, count=1, flags=re.DOTALL)
    else:
        text = text.replace("</sheets>", f"</sheets>{serialized}", 1)
    return text.encode("utf-8")
