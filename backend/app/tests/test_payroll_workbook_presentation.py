import hashlib
import xml.etree.ElementTree as ET
from io import BytesIO
from zipfile import ZIP_DEFLATED, ZipFile

import pytest
from fastapi import HTTPException

from app.services.payroll_month_xlsx_service import (
    _preserve_ignorable_namespaces,
    _set_cell_string,
)
from app.services.payroll_workbook_presentation import prepare_payroll_workbook_download
from app.tests.test_payroll_individual_month_download import approved_workers as approved_workers
from app.tests.test_payroll_month_xlsx_service import NS, cell_number_format, cell_text


def legacy_presentation(content, *, manual_remark=None):
    """Recreate the previous export's remarks and 12pt closing balance."""
    with ZipFile(BytesIO(content)) as source:
        sheet = ET.fromstring(source.read("xl/worksheets/sheet1.xml"))
        styles = ET.fromstring(source.read("xl/styles.xml"))
        closing = sheet.find('.//main:c[@r="K51"]', NS)
        style = styles.find("main:cellXfs", NS)[int(closing.get("s"))]
        style.set("fontId", "0")  # The template's original Aptos Narrow 12pt.
        style.attrib.pop("applyFont", None)
        if manual_remark is None:
            for ref, value in {
                "I46": "Monatsdifferenz: +2:30",
                "I47": "Stundenkonto: +2:30",
                "I48": "Auszahlung siehe Überstunden 25 %",
                "I49": "Kontogrenze: 100:00 Std.",
            }.items():
                _set_cell_string(sheet, ref, value)
        else:
            _set_cell_string(sheet, "I46", manual_remark)
        output = BytesIO()
        with ZipFile(output, "w", ZIP_DEFLATED) as target:
            for item in source.infolist():
                root = {"xl/worksheets/sheet1.xml": sheet, "xl/styles.xml": styles}.get(
                    item.filename
                )
                target.writestr(
                    item,
                    source.read(item.filename)
                    if root is None
                    else _preserve_ignorable_namespaces(
                        ET.tostring(root, encoding="UTF-8", xml_declaration=True)
                    ),
                )
        return output.getvalue()


def assert_corrected_footer(content, *, sheet_path="xl/worksheets/sheet1.xml"):
    with ZipFile(BytesIO(content)) as package:
        sheet = ET.fromstring(package.read(sheet_path))
        styles = ET.fromstring(package.read("xl/styles.xml"))
    assert all(cell_text(sheet, f"I{row}") == "" for row in range(46, 50))
    xfs = styles.find("main:cellXfs", NS)
    sick = sheet.find('.//main:c[@r="G48"]', NS)
    assert cell_number_format(sheet, styles, "G48") == '[h]:mm" h"'
    assert xfs[int(sick.get("s"))].find("main:alignment", NS).get("horizontal") == "right"
    font_ids = [
        xfs[int(sheet.find(f'.//main:c[@r="{ref}"]', NS).get("s"))].get("fontId")
        for ref in ("K50", "K51")
    ]
    assert font_ids[0] == font_ids[1]
    assert styles.find("main:fonts", NS)[int(font_ids[1])].find("main:sz", NS).get("val") == "10"


def test_retained_and_new_approvals_download_together_without_changing_stored_data(
    approved_workers,
):
    case = approved_workers
    old = legacy_presentation(case.workbooks[0])
    artifact = case.artifacts[0]
    artifact.content = old
    artifact.byte_size = len(old)
    artifact.content_sha256 = hashlib.sha256(old).hexdigest()
    case.db.commit()

    single = case.service.worker_export(person_id=artifact.person_id, **case.args)
    assert_corrected_footer(single)
    combined = case.service.all_workers_export(**case.args)
    for index in (1, 2):
        assert_corrected_footer(combined, sheet_path=f"xl/worksheets/sheet{index}.xml")
    with ZipFile(BytesIO(single)) as changed, ZipFile(BytesIO(old)) as retained:
        for path in retained.namelist():
            if path not in {"xl/worksheets/sheet1.xml", "xl/styles.xml"}:
                assert changed.read(path) == retained.read(path)
        before = ET.fromstring(retained.read("xl/worksheets/sheet1.xml"))
        after = ET.fromstring(changed.read("xl/worksheets/sheet1.xml"))
        for cell in before.findall(".//main:c", NS):
            if cell.get("r") not in {"I46", "I47", "I48", "I49"}:
                corrected = after.find(f'.//main:c[@r="{cell.get("r")}"]', NS)
                cell.attrib.pop("s", None)
                corrected.attrib.pop("s", None)
                assert ET.tostring(cell) == ET.tostring(corrected)
    assert prepare_payroll_workbook_download(single) == single
    current = prepare_payroll_workbook_download(case.workbooks[1])
    assert prepare_payroll_workbook_download(current) == current
    assert artifact.content == old
    assert artifact.content_sha256 == hashlib.sha256(old).hexdigest()
    assert [(row.status, row.approval_version) for row in case.approvals] == [("APPROVED", 1)] * 2
    assert not case.db.new and not case.db.dirty and not case.db.deleted


@pytest.mark.parametrize(
    "remark", ["Bitte Rücksprache halten", "Monatsdifferenz: individuell prüfen"]
)
def test_manual_remarks_are_preserved(approved_workers, remark):
    original = legacy_presentation(approved_workers.workbooks[0], manual_remark=remark)
    corrected = prepare_payroll_workbook_download(original)
    with ZipFile(BytesIO(original)) as before, ZipFile(BytesIO(corrected)) as after:
        old_sheet = ET.fromstring(before.read("xl/worksheets/sheet1.xml"))
        new_sheet = ET.fromstring(after.read("xl/worksheets/sheet1.xml"))
        for cell in old_sheet.findall(".//main:c", NS):
            changed = new_sheet.find(f'.//main:c[@r="{cell.get("r")}"]', NS)
            cell.attrib.pop("s", None)
            changed.attrib.pop("s", None)
            assert ET.tostring(cell) == ET.tostring(changed)
        assert cell_text(new_sheet, "I46") == remark


def test_locked_download_uses_presentation_copy_without_rebuilding(approved_workers, monkeypatch):
    from types import SimpleNamespace
    from app.models.payroll_month import PayrollMonthPeriod

    case = approved_workers
    old = legacy_presentation(case.workbooks[0])
    case.db.add(PayrollMonthPeriod(year=2026, month=8, status="LOCKED", last_snapshot_version=1))
    case.db.commit()
    monkeypatch.setattr(
        case.service, "_locked_artifact", lambda **kwargs: SimpleNamespace(content=old)
    )
    assert_corrected_footer(case.service.worker_export(person_id=1, **case.args))
    assert_corrected_footer(case.service.all_workers_export(**case.args, version=1))


def test_unsupported_xml_keeps_the_existing_combined_export_error(approved_workers):
    case = approved_workers
    output = BytesIO()
    with ZipFile(BytesIO(case.workbooks[0])) as source, ZipFile(output, "w") as target:
        for item in source.infolist():
            target.writestr(
                item, b"<broken" if item.filename == "xl/styles.xml" else source.read(item.filename)
            )
    content = output.getvalue()
    case.artifacts[0].content = content
    case.artifacts[0].byte_size = len(content)
    case.artifacts[0].content_sha256 = hashlib.sha256(content).hexdigest()
    case.db.commit()
    with pytest.raises(HTTPException) as caught:
        case.service.all_workers_export(**case.args)
    assert caught.value.status_code == 409
    assert caught.value.detail["code"] == "payroll_approved_workbooks_incompatible"


def test_download_layout_preserves_calculations_and_unrelated_styles(approved_workers):
    original = approved_workers.workbooks[0]
    corrected = prepare_payroll_workbook_download(original)
    with ZipFile(BytesIO(original)) as before, ZipFile(BytesIO(corrected)) as after:
        old_sheet = ET.fromstring(before.read("xl/worksheets/sheet1.xml"))
        sheet = ET.fromstring(after.read("xl/worksheets/sheet1.xml"))
        old_styles = ET.fromstring(before.read("xl/styles.xml"))
        styles = ET.fromstring(after.read("xl/styles.xml"))

    def style(root, definitions, ref):
        cell = root.find(f'.//main:c[@r="{ref}"]', NS)
        return definitions.find("main:cellXfs", NS)[int(cell.get("s", "0"))]

    merges = {merge.get("ref") for merge in sheet.find("main:mergeCells", NS)}
    old_merges = {merge.get("ref") for merge in old_sheet.find("main:mergeCells", NS)}
    assert merges == old_merges - {f"C{row}:E{row}" for row in (2, 3, 4)} | {
        f"C{row}:F{row}" for row in (2, 3, 4)
    }
    for ref in ("C2", "C4"):
        assert style(sheet, styles, ref).find("main:alignment", NS).get("horizontal") == "right"
    for row in (2, 3, 4):
        assert style(sheet, styles, f"F{row}").get("borderId") == style(old_sheet, old_styles, f"E{row}").get("borderId")
    travel = {f"{column}{row}" for row in range(10, 41) for column in "IJKL"}
    gray = {"E41", "D46", "E46", "D47", "E47", "D48", "E48", "G48"}
    gray |= {f"{column}{row}" for row in range(49, 53) for column in "EG"}
    gray |= {f"{column}{row}" for row in range(46, 50) for column in "IJKL"}
    gray |= {f"{column}{row}" for row in (50, 51) for column in "KL"}
    for ref in travel:
        alignment = style(sheet, styles, ref).find("main:alignment", NS)
        assert alignment.get("horizontal") == alignment.get("vertical") == "center"
    for ref in gray:
        fill = styles.find("main:fills", NS)[int(style(sheet, styles, ref).get("fillId"))]
        assert fill.find("main:patternFill/main:fgColor", NS).get("rgb") == "FFF2F2F2"
    for old_cell in old_sheet.findall(".//main:c", NS):
        ref = old_cell.get("r")
        new_cell = sheet.find(f'.//main:c[@r="{ref}"]', NS)
        if ref not in travel | gray | {"C2", "C4", "F2", "F3", "F4"}:
            assert ET.tostring(style(sheet, styles, ref)) == ET.tostring(style(old_sheet, old_styles, ref))
        old_cell.attrib.pop("s", None)
        new_cell.attrib.pop("s", None)
        assert ET.tostring(old_cell) == ET.tostring(new_cell)
    assert prepare_payroll_workbook_download(corrected) == corrected
