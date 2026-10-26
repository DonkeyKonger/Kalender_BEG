import hashlib
import xml.etree.ElementTree as ET
from datetime import date
from io import BytesIO
from zipfile import ZIP_DEFLATED, ZipFile

import pytest

from app.models.enums import AbsenceStatus, AbsenceType
from app.models.person import Person
from app.services.payroll_month_xlsx_service import (
    PayrollMonthSheet, _clear_cell, _preserve_ignorable_namespaces,
    _set_cell_number, _set_cell_string, build_payroll_month_xlsx, build_payroll_months_xlsx,
)
from app.services.payroll_workbook_presentation import prepare_payroll_workbook_download
from app.tests.test_payroll_individual_month_download import approved_workers as approved_workers
from app.tests.test_payroll_month_absences import PERSON, absence
from app.tests.test_payroll_month_xlsx_service import NS, cell_text
from app.tests.test_payroll_print_layout import assert_single_page_per_sheet


def read_sheet(content, index=1):
    with ZipFile(BytesIO(content)) as book:
        return ET.fromstring(book.read(f"xl/worksheets/sheet{index}.xml"))


@pytest.mark.parametrize("multi", [False, True])
@pytest.mark.parametrize("has_vacation", [False, True])
def test_summary_counts_only_credited_monthly_vacation_days(multi, has_vacation):
    records = [] if not has_vacation else [
        absence(AbsenceType.VACATION, date(2026, 3, 30), date(2026, 4, 7)),
        absence(AbsenceType.VACATION, date(2026, 4, 2)),  # Duplicate date.
        absence(AbsenceType.VACATION, date(2026, 4, 8), status=AbsenceStatus.CANCELLED),
        absence(AbsenceType.VACATION, date(2026, 4, 9), person_id=2),
        absence(AbsenceType.SICK, date(2026, 4, 10)),
        absence(AbsenceType.FREE, date(2026, 4, 13)),
    ]
    fields = dict(
        person=PERSON, year=2026, month=4, entries=[], absences=records,
        non_working_dates={date(2026, 4, 3), date(2026, 4, 6)},
        remarks="Bitte prüfen",
    )
    result = (
        build_payroll_months_xlsx([PayrollMonthSheet(sheet_name="Test", **fields)])
        if multi else build_payroll_month_xlsx(**fields)
    )
    for content in (result.content, prepare_payroll_workbook_download(result.content)):
        sheet = read_sheet(content)
        assert cell_text(sheet, "I42") == f"Urlaubstage: {3 if has_vacation else 0}"
        assert "".join(sheet.find('.//main:c[@r="I46"]/main:is', NS).itertext()) == "Bitte prüfen"
        assert sheet.find('main:mergeCells/main:mergeCell[@ref="I42:L44"]', NS) is not None
        assert_single_page_per_sheet(content)


def test_multi_export_counts_each_person_separately():
    other = Person(id=2, display_name="Ohne Urlaub", weekly_hours=40)
    records = [absence(AbsenceType.VACATION, date(2026, 8, 3), date(2026, 8, 4))]
    result = build_payroll_months_xlsx([
        PayrollMonthSheet(person=p, sheet_name=p.display_name, year=2026, month=8,
                          entries=[], absences=records)
        for p in (PERSON, other)
    ])
    assert cell_text(read_sheet(result.content, 1), "I42") == "Urlaubstage: 2"
    assert cell_text(read_sheet(result.content, 2), "I42") == "Urlaubstage: 0"


@pytest.mark.parametrize("vacation_rows", [(), (12, 13)])
def test_retained_approved_downloads_fill_summary_from_stored_days(approved_workers, vacation_rows):
    case = approved_workers
    output = BytesIO()
    with ZipFile(BytesIO(case.artifacts[0].content)) as source, ZipFile(output, "w", ZIP_DEFLATED) as target:
        for item in source.infolist():
            payload = source.read(item.filename)
            if item.filename == "xl/worksheets/sheet1.xml":
                sheet = ET.fromstring(payload)
                _clear_cell(sheet, "I42")  # Workbook predating the summary.
                for row in vacation_rows:
                    for col in "BCDFG":
                        _clear_cell(sheet, f"{col}{row}")
                    _set_cell_string(sheet, f"H{row}", "Urlaub")
                    _set_cell_number(sheet, f"E{row}", 8 / 24)
                payload = _preserve_ignorable_namespaces(ET.tostring(sheet))
            target.writestr(item, payload)
    old = output.getvalue()
    artifact = case.artifacts[0]
    artifact.content = old
    artifact.byte_size = len(old)
    artifact.content_sha256 = hashlib.sha256(old).hexdigest()
    case.db.commit()
    downloaded = case.service.worker_export(person_id=artifact.person_id, **case.args)
    assert cell_text(read_sheet(downloaded), "I42") == f"Urlaubstage: {len(vacation_rows)}"
    combined = case.service.all_workers_export(**case.args)
    summaries = [cell_text(read_sheet(combined, i), "I42") for i in (1, 2)]
    assert sorted(summaries) == ["Urlaubstage: 0", f"Urlaubstage: {len(vacation_rows)}"]
    before = read_sheet(old)
    after = read_sheet(downloaded)
    for cell in before.findall(".//main:c", NS):
        if cell.get("r") == "I42":
            continue
        changed = after.find(f'.//main:c[@r="{cell.get("r")}"]', NS)
        cell.attrib.pop("s", None)
        changed.attrib.pop("s", None)
        assert ET.tostring(cell) == ET.tostring(changed)
    assert artifact.content == old
    assert artifact.content_sha256 == hashlib.sha256(old).hexdigest()
    assert prepare_payroll_workbook_download(downloaded) == downloaded
    assert not case.db.new and not case.db.dirty and not case.db.deleted
