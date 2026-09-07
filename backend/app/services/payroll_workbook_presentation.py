"""Apply presentation corrections to download copies of retained payroll workbooks."""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from copy import deepcopy
from io import BytesIO
from zipfile import ZIP_DEFLATED, BadZipFile, ZipFile, is_zipfile

from app.services.payroll_month_xlsx_service import (
    _clear_cell,
    _find_cell,
    _preserve_ignorable_namespaces,
    _qname,
)


def prepare_payroll_workbook_download(content: bytes) -> bytes:
    """Keep approved values/formulas and stored bytes; only correct their presentation.

    Align the header and travel markers and shade the generated footer fields.
    Remove only the complete, known generated remarks block. Unrelated/manual remarks
    and fallback exports are preserved. Applying the same styles to retained and newly
    approved sheets keeps them compatible without rebuilding payroll data.
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
    """Style only export fields; keep retained payroll values and formulas intact."""
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
        for merge in merges:
            if merge.get("ref") == "C2:E2":
                extension = _find_cell(sheet, "F2")
                if extension is None or not list(extension):
                    merge.set("ref", "C2:F2")
                    previous_edge = _find_cell(sheet, "E2")
                    if extension is None and previous_edge is not None:
                        row = sheet.find(f"{_qname('sheetData')}/{_qname('row')}[@r='2']")
                        if row is not None:
                            extension = ET.Element(_qname("c"), r="F2")
                            row.insert(list(row).index(previous_edge) + 1, extension)
                    if extension is not None and previous_edge is not None:
                        extension.set("s", previous_edge.get("s", "0"))
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
    format_cell("G48", horizontal="right", number_format='[h]:mm" h"')
    return ET.tostring(styles) != original_styles


def _xml(root: ET.Element) -> bytes:
    return _preserve_ignorable_namespaces(ET.tostring(root, encoding="UTF-8", xml_declaration=True))
