"""Apply presentation corrections to download copies of retained payroll workbooks."""

from __future__ import annotations

import posixpath
import re
import xml.etree.ElementTree as ET
from copy import deepcopy
from io import BytesIO
from zipfile import ZIP_DEFLATED, BadZipFile, ZipFile, is_zipfile

from app.services.payroll_month_xlsx_service import (
    PAYROLL_MONTH_TEMPLATE_LAYOUT,
    _clear_cell,
    _find_cell,
    _preserve_ignorable_namespaces,
    _qname,
    _set_cell_string,
)
from app.services.payroll_print_layout import (
    configure_payroll_print_areas,
    configure_payroll_print_sheet,
)


def prepare_payroll_workbook_download(content: bytes) -> bytes:
    """Keep approved hours and stored bytes; only correct the download presentation.

    Fit each monthly form on one A4 page, align the header and travel markers,
    and shade the generated footer fields. Fill the vacation summary from the
    retained daily rows without consulting current absence data.
    Remove only the complete, known generated remarks block. Unrelated/manual remarks
    and fallback exports are preserved. Applying the same styles to retained and newly
    approved sheets keeps them compatible without rebuilding payroll data.
    Convert the known legacy total-hours formula and its cached value from Excel
    days to decimal hours, adjusting the dependent overtime formula in the copy.
    """
    try:
        return _prepare_download(content)
    except (BadZipFile, ET.ParseError, IndexError, KeyError, ValueError):
        # Unsupported packages retain the existing download/merge validation path.
        return content


def _prepare_download(content: bytes) -> bytes:
    if not is_zipfile(BytesIO(content)):
        return content
    with ZipFile(BytesIO(content)) as source:
        if "xl/styles.xml" not in source.namelist():
            return content
        styles = ET.fromstring(source.read("xl/styles.xml"))
        cell_xfs = styles.find(_qname("cellXfs"))
        if cell_xfs is None:
            return content
        shared_strings = (
            [
                "".join(item.itertext())
                for item in ET.fromstring(source.read("xl/sharedStrings.xml"))
            ]
            if "xl/sharedStrings.xml" in source.namelist()
            else []
        )

        def text(sheet: ET.Element, ref: str) -> str:
            cell = _find_cell(sheet, ref)
            if cell is None:
                return ""
            if cell.get("t") == "s":
                return shared_strings[int(cell.findtext(_qname("v")))]
            return (
                "".join(cell.find(_qname("is")).itertext()) if cell.get("t") == "inlineStr" else ""
            )

        workbook_xml = source.read("xl/workbook.xml")
        workbook = ET.fromstring(workbook_xml)
        relationships = ET.fromstring(source.read("xl/_rels/workbook.xml.rels"))
        targets = {
            item.get("Id"): posixpath.normpath(posixpath.join("xl", item.get("Target", ""))).lstrip("/")
            for item in relationships
        }
        sheet_indices = {
            targets[item.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")]: index
            for index, item in enumerate(
                workbook.findall(f"{_qname('sheets')}/{_qname('sheet')}")
            )
        }
        payroll_indices: list[int] = []
        replacements: dict[str, bytes] = {}
        styles_changed = False
        for path in source.namelist():
            if not re.fullmatch(r"xl/worksheets/sheet\d+\.xml", path):
                continue
            sheet = ET.fromstring(source.read(path))
            original_sheet = ET.tostring(sheet)
            opening = _find_cell(sheet, "K50")
            closing = _find_cell(sheet, "K51")
            if (
                opening is None
                or closing is None
                or text(sheet, "I50") not in {"Kontostand alt:", "Konstostand alt:"}
                or text(sheet, "I51") not in {"Kontostand neu:", "Konstostand neu:"}
            ):
                continue
            layout = PAYROLL_MONTH_TEMPLATE_LAYOUT
            vacation_summary = _find_cell(sheet, layout.vacation_days_cell)
            if vacation_summary is not None and not list(vacation_summary):
                # Old approved exports already contain the credited vacation days.
                # Preserve any existing summary or manually entered field content.
                vacation_days = sum(
                    text(sheet, f"{layout.address_column}{row}") == "Urlaub"
                    and all(text(sheet, f"{column}{row}") == "" for column in "BCDFG")
                    for row in range(layout.first_day_row, layout.last_day_row + 1)
                )
                _set_cell_string(sheet, layout.vacation_days_cell, f"Urlaubstage: {vacation_days}")
            configure_payroll_print_sheet(sheet)
            payroll_indices.append(sheet_indices[path])
            # Standard payroll exports give K51 its own duration style. Do not
            # change a shared style that could affect unrelated cells.
            closing_style_id = closing.get("s", "0")
            closing_style = cell_xfs[int(closing_style_id)]
            opening_style = cell_xfs[int(opening.get("s", "0"))]
            if closing_style.get("fontId") != opening_style.get("fontId") and all(
                cell.get("r") == "K51"
                for cell in sheet.iter(_qname("c"))
                if cell.get("s", "0") == closing_style_id
            ):
                closing_style.attrib.update(fontId=opening_style.attrib["fontId"], applyFont="1")
                styles_changed = True
            generated_remarks = {
                "I46": r"Monatsdifferenz: (?:offen|[+-]?\d+:\d{2})",
                "I47": r"Stundenkonto: (?:offen|[+-]?\d+:\d{2})",
                "I48": r"Auszahlung (?:offen|siehe Überstunden 25 %)",
                "I49": r"Kontogrenze: 100:00 Std\.",
            }
            if all(
                re.fullmatch(pattern, text(sheet, ref))
                for ref, pattern in generated_remarks.items()
            ):
                for ref in generated_remarks:
                    _clear_cell(sheet, ref)
            if _format_payroll_fields(sheet, styles):
                styles_changed = True
            if ET.tostring(sheet) != original_sheet:
                replacements[path] = _xml(sheet)
        printed_workbook = configure_payroll_print_areas(workbook_xml, payroll_indices)
        if printed_workbook != workbook_xml:
            replacements["xl/workbook.xml"] = printed_workbook
        if styles_changed:
            replacements["xl/styles.xml"] = _xml(styles)
        if not replacements:
            return content
        output = BytesIO()
        with ZipFile(output, "w", ZIP_DEFLATED) as target:
            for item in source.infolist():
                target.writestr(item, replacements.get(item.filename, source.read(item.filename)))
        return output.getvalue()


def _format_payroll_fields(sheet: ET.Element, styles: ET.Element) -> bool:
    """Style export fields, preserving approved hours when converting their units."""
    cell_xfs = styles.find(_qname("cellXfs"))
    fills = styles.find(_qname("fills"))
    if cell_xfs is None or fills is None:
        return False
    original_styles = ET.tostring(styles)
    gray_fill = ET.Element(_qname("fill"))
    pattern = ET.SubElement(gray_fill, _qname("patternFill"), patternType="solid")
    ET.SubElement(pattern, _qname("fgColor"), rgb="FFF2F2F2")
    ET.SubElement(pattern, _qname("bgColor"), indexed="64")

    def reuse_or_append(collection: ET.Element, element: ET.Element) -> int:
        serialized = ET.tostring(element)
        for index, existing in enumerate(collection):
            if ET.tostring(existing) == serialized:
                return index
        collection.append(element)
        collection.set("count", str(len(collection)))
        return len(collection) - 1

    gray_fill_id = reuse_or_append(fills, gray_fill)

    def format_cell(
        ref: str, *, horizontal: str | None = None, gray: bool = False,
        number_format: str | None = None,
    ):
        cell = _find_cell(sheet, ref)
        if cell is None:
            return
        style = deepcopy(cell_xfs[int(cell.get("s", "0"))])
        if number_format is not None:
            num_fmts = styles.find(_qname("numFmts"))
            if num_fmts is None:
                num_fmts = ET.Element(_qname("numFmts"))
                styles.insert(0, num_fmts)
            matching = next(
                (item for item in num_fmts if item.get("formatCode") == number_format),
                None,
            )
            if matching is None:
                format_id = max([163, *(int(item.get("numFmtId")) for item in num_fmts)]) + 1
                matching = ET.SubElement(
                    num_fmts, _qname("numFmt"),
                    numFmtId=str(format_id), formatCode=number_format,
                )
                num_fmts.set("count", str(len(num_fmts)))
            style.attrib.update(numFmtId=matching.get("numFmtId"), applyNumberFormat="1")
        if horizontal is not None:
            alignment = style.find(_qname("alignment"))
            if alignment is None:
                alignment = ET.SubElement(style, _qname("alignment"))
            alignment.set("horizontal", horizontal)
            if horizontal == "center":
                alignment.set("vertical", "center")
            style.set("applyAlignment", "1")
        if gray:
            style.attrib.update(fillId=str(gray_fill_id), applyFill="1")
        cell.set("s", str(reuse_or_append(cell_xfs, style)))

    merges = sheet.find(_qname("mergeCells"))
    if merges is not None:
        header_merges = {f"C{row}:E{row}": row for row in (2, 3, 4)}
        for merge in merges:
            row_number = header_merges.get(merge.get("ref"))
            if row_number is not None:
                extension = _find_cell(sheet, f"F{row_number}")
                if extension is None or not list(extension):
                    merge.set("ref", f"C{row_number}:F{row_number}")
                    previous_edge = _find_cell(sheet, f"E{row_number}")
                    if extension is None and previous_edge is not None:
                        row = sheet.find(f"{_qname('sheetData')}/{_qname('row')}[@r='{row_number}']")
                        if row is not None:
                            extension = ET.Element(_qname("c"), r=f"F{row_number}")
                            row.insert(list(row).index(previous_edge) + 1, extension)
                    if extension is not None and previous_edge is not None:
                        extension.set("s", previous_edge.get("s", "0"))
    format_cell(PAYROLL_MONTH_TEMPLATE_LAYOUT.vacation_days_cell, horizontal="center")
    for ref in ("C2", "C4"):
        format_cell(ref, horizontal="right")
    for row in range(10, 41):
        for column in "IJKL":
            format_cell(f"{column}{row}", horizontal="center")
    # Include the full merged fields, but leave labels and manual office areas white.
    gray_fields = ["E41", "D46", "E46", "D47", "E47", "D48", "E48", "G48"]
    gray_fields += [f"{column}{row}" for row in range(49, 53) for column in "EG"]
    gray_fields += [f"{column}{row}" for row in range(46, 50) for column in "IJKL"]
    gray_fields += [f"{column}{row}" for row in (50, 51) for column in "KL"]
    for ref in gray_fields:
        format_cell(ref, gray=True)
    if _decimal_total_hours(sheet):
        format_cell(PAYROLL_MONTH_TEMPLATE_LAYOUT.total_hours_cell,
                    horizontal="right", number_format="0.00")
    format_cell("G48", horizontal="right", number_format='[h]:mm" h"')
    return ET.tostring(styles) != original_styles


def _decimal_total_hours(sheet: ET.Element) -> bool:
    """Normalize only the generated total; leave custom formulas and payouts alone."""
    layout = PAYROLL_MONTH_TEMPLATE_LAYOUT
    cell = _find_cell(sheet, layout.total_hours_cell)
    if cell is None:
        return False
    formula = cell.find(_qname("f"))
    legacy = (f"SUM({layout.net_work_column}{layout.first_day_row}:"
              f"{layout.net_work_column}{layout.last_day_row})")
    if formula is None or formula.text not in {legacy, f"{legacy}*24"}:
        return False
    if formula.text == legacy:
        value = cell.find(_qname("v"))
        if value is not None and value.text:
            # Stored payroll totals have minute precision. Remove only the
            # floating-point noise introduced by Excel's day representation.
            value.text = str(round(float(value.text) * 1440) / 60)
        formula.text = f"{legacy}*24"
        overtime = _find_cell(sheet, layout.overtime_hours_cell)
        dependent = overtime.find(_qname("f")) if overtime is not None else None
        if dependent is not None and dependent.text:
            dependent.text = dependent.text.replace(
                f"{layout.total_hours_cell}*24-{layout.normal_hours_cell}",
                f"{layout.total_hours_cell}-{layout.normal_hours_cell}",
            )
    return True


def _xml(root: ET.Element) -> bytes:
    return _preserve_ignorable_namespaces(ET.tostring(root, encoding="UTF-8", xml_declaration=True))
