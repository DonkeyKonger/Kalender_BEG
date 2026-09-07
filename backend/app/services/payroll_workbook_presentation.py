"""Apply presentation corrections to download copies of retained payroll workbooks."""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
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

    Remove only the complete, known generated remarks block. Unrelated/manual remarks
    and fallback exports are preserved. Matching the current export styles also allows
    retained and newly approved sheets to be combined without rebuilding payroll data.
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


def _xml(root: ET.Element) -> bytes:
    return _preserve_ignorable_namespaces(ET.tostring(root, encoding="UTF-8", xml_declaration=True))
