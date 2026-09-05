from __future__ import annotations

import posixpath
import xml.etree.ElementTree as ET
from datetime import date
from io import BytesIO
from zipfile import ZIP_DEFLATED, ZipFile

import pytest

from app.models.absence import Absence
from app.models.enums import AbsenceStatus, AbsenceType
from app.models.person import Person
from app.services.payroll_approved_workbook_merge import (
    merge_approved_payroll_workbooks,
)
from app.services.payroll_month_xlsx_service import (
    PayrollMonthSheet,
    build_payroll_months_xlsx,
)
from app.tests.test_payroll_month_xlsx_service import (
    cell_text,
    long_week_entries,
    make_entry,
)


_SPREADSHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
_PACKAGE_RELATIONSHIPS_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
_DOCUMENT_RELATIONSHIPS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_CONTENT_TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types"


def test_merge_preserves_two_real_normal_exports_byte_for_byte_per_sheet():
    vacation_person = Person(
        id=1,
        first_name="Anna",
        last_name="Bau",
        display_name="Anna Bau",
        short_code="AB",
        weekly_hours=40,
    )
    vacation_entry = make_entry(
        101,
        date(2026, 8, 3),
        "06:00",
        "14:15",
        None,
    )
    vacation = Absence(
        person_id=vacation_person.id,
        absence_type=AbsenceType.VACATION,
        status=AbsenceStatus.ACTIVE,
        start_date=date(2026, 8, 4),
        end_date=date(2026, 8, 5),
    )
    vacation_export = build_payroll_months_xlsx(
        [
            PayrollMonthSheet(
                person=vacation_person,
                sheet_name=vacation_person.display_name,
                year=2026,
                month=8,
                entries=[vacation_entry],
                absences=[vacation],
            )
        ]
    )

    distributed_person = Person(
        id=2,
        first_name="Max",
        last_name="Strom",
        display_name="Max Strom",
        short_code="MS",
        weekly_hours=40,
    )
    distributed_entries = long_week_entries([1, 2, 3, 4], end="16:00")
    for entry in distributed_entries:
        entry.person_id = distributed_person.id
    distributed_export = build_payroll_months_xlsx(
        [
            PayrollMonthSheet(
                person=distributed_person,
                sheet_name=distributed_person.display_name,
                year=2026,
                month=6,
                entries=distributed_entries,
            )
        ]
    )

    assert [day.net_work_minutes for day in distributed_export.plans[0].days] == [432] * 5
    assert sum(day.net_work_minutes for day in vacation_export.plans[0].days) == 1455
    combined = merge_approved_payroll_workbooks(
        [
            (vacation_person.display_name, vacation_export.content),
            (distributed_person.display_name, distributed_export.content),
        ]
    )

    with (
        ZipFile(BytesIO(vacation_export.content)) as vacation_book,
        ZipFile(BytesIO(distributed_export.content)) as distributed_book,
        ZipFile(BytesIO(combined)) as combined_book,
    ):
        assert combined_book.testzip() is None
        vacation_sheet = vacation_book.read("xl/worksheets/sheet1.xml")
        distributed_sheet = distributed_book.read("xl/worksheets/sheet1.xml")
        assert combined_book.read("xl/worksheets/sheet1.xml") == vacation_sheet
        assert combined_book.read("xl/worksheets/sheet2.xml") == distributed_sheet

        styles = vacation_book.read("xl/styles.xml")
        assert distributed_book.read("xl/styles.xml") == styles
        assert combined_book.read("xl/styles.xml") == styles
        assert _cell_payloads(combined_book.read("xl/worksheets/sheet1.xml")) == (
            _cell_payloads(vacation_sheet)
        )
        assert _cell_payloads(combined_book.read("xl/worksheets/sheet2.xml")) == (
            _cell_payloads(distributed_sheet)
        )
        assert _print_settings(combined_book.read("xl/worksheets/sheet1.xml")) == (
            _print_settings(vacation_sheet)
        )
        assert _print_settings(combined_book.read("xl/worksheets/sheet2.xml")) == (
            _print_settings(distributed_sheet)
        )

        assert combined_book.read("xl/media/image1.png") == vacation_book.read(
            "xl/media/image1.png"
        )
        assert combined_book.read("xl/media/image1.png") == distributed_book.read(
            "xl/media/image1.png"
        )
        assert combined_book.read("xl/drawings/drawing1.xml") == vacation_book.read(
            "xl/drawings/drawing1.xml"
        )
        assert combined_book.read("xl/drawings/drawing2.xml") == distributed_book.read(
            "xl/drawings/drawing1.xml"
        )

        workbook_root = ET.fromstring(combined_book.read("xl/workbook.xml"))
        sheets = workbook_root.findall(f"{{{_SPREADSHEET_NS}}}sheets/{{{_SPREADSHEET_NS}}}sheet")
        assert [sheet.get("name") for sheet in sheets] == ["Bau", "Strom"]
        assert [sheet.get(f"{{{_DOCUMENT_RELATIONSHIPS_NS}}}id") for sheet in sheets] == [
            "rIdSheet1",
            "rIdSheet2",
        ]
        _assert_all_internal_relationships_resolve(combined_book)
        _assert_generated_content_types(combined_book, sheet_count=2)

        vacation_root = ET.fromstring(vacation_sheet)
        distributed_root = ET.fromstring(distributed_sheet)
        assert cell_text(vacation_root, "H13") == "Urlaub"
        assert cell_text(vacation_root, "H14") == "Urlaub"
        assert float(cell_text(vacation_root, "E41")) * 24 == pytest.approx(24.25)
        assert float(cell_text(distributed_root, "E41")) * 24 == pytest.approx(36)
        assert cell_text(distributed_root, "B14") == "06:00"
        assert cell_text(distributed_root, "C14") == "13:57"


def test_merge_sanitizes_and_deduplicates_requested_sheet_names():
    first = _empty_normal_export("Erika Nord", person_id=1)
    second = _empty_normal_export("Max Nord", person_id=2)

    combined = merge_approved_payroll_workbooks(
        [("Team [Nord]", first), ("Kollege [Nord]", second)]
    )

    with ZipFile(BytesIO(combined)) as workbook:
        root = ET.fromstring(workbook.read("xl/workbook.xml"))
        sheets = root.findall(f"{{{_SPREADSHEET_NS}}}sheets/{{{_SPREADSHEET_NS}}}sheet")
    assert [sheet.get("name") for sheet in sheets] == ["Nord", "Nord 2"]


def test_merge_rejects_raw_or_incompatible_workbooks_without_partial_fallback():
    normal = _empty_normal_export("Erika Bau", person_id=1)

    with pytest.raises(ValueError, match="Mindestens ein"):
        merge_approved_payroll_workbooks([])
    with pytest.raises(ValueError, match="Kein lesbarer normaler XLSX-Export"):
        merge_approved_payroll_workbooks([("Rohdaten", b"not an xlsx")])

    missing_drawing = _rewrite_zip(normal, remove="xl/drawings/drawing1.xml")
    with pytest.raises(ValueError, match="Inkompatibler XLSX-Aufbau"):
        merge_approved_payroll_workbooks([("Unvollständig", missing_drawing)])

    changed_styles = _rewrite_zip(
        normal,
        replace={
            "xl/styles.xml": _zip_part(normal, "xl/styles.xml").replace(
                b"</styleSheet>", b"<!-- incompatible -->\n</styleSheet>"
            )
        },
    )
    with pytest.raises(ValueError, match="Styles unterscheiden sich"):
        merge_approved_payroll_workbooks([("Original", normal), ("Fremde Styles", changed_styles)])


def _empty_normal_export(name: str, *, person_id: int) -> bytes:
    person = Person(
        id=person_id,
        first_name=name.split()[0],
        last_name=name.split()[-1],
        display_name=name,
        short_code=f"P{person_id}",
        weekly_hours=40,
    )
    return build_payroll_months_xlsx([PayrollMonthSheet(person, name, 2026, 8, [])]).content


def _cell_payloads(sheet_xml: bytes) -> list[tuple[object, ...]]:
    root = ET.fromstring(sheet_xml)
    cells: list[tuple[object, ...]] = []
    for cell in root.findall(f".//{{{_SPREADSHEET_NS}}}c"):
        formula = cell.find(f"{{{_SPREADSHEET_NS}}}f")
        value = cell.find(f"{{{_SPREADSHEET_NS}}}v")
        inline_text = cell.find(f"{{{_SPREADSHEET_NS}}}is/{{{_SPREADSHEET_NS}}}t")
        cells.append(
            (
                cell.get("r"),
                cell.get("s"),
                cell.get("t"),
                None if formula is None else formula.text,
                None if value is None else value.text,
                None if inline_text is None else inline_text.text,
            )
        )
    return cells


def _print_settings(sheet_xml: bytes) -> list[bytes]:
    root = ET.fromstring(sheet_xml)
    names = ("printOptions", "pageMargins", "pageSetup", "headerFooter")
    return [
        ET.tostring(element)
        for name in names
        if (element := root.find(f"{{{_SPREADSHEET_NS}}}{name}")) is not None
    ]


def _assert_all_internal_relationships_resolve(workbook: ZipFile) -> None:
    parts = set(workbook.namelist())
    for relationships_path in sorted(path for path in parts if path.endswith(".rels")):
        root = ET.fromstring(workbook.read(relationships_path))
        if relationships_path == "_rels/.rels":
            base_path = ""
        else:
            directory, separator, relationship_name = relationships_path.rpartition("/_rels/")
            assert separator
            base_path = posixpath.dirname(
                posixpath.join(directory, relationship_name.removesuffix(".rels"))
            )
        for relationship in root.findall(f"{{{_PACKAGE_RELATIONSHIPS_NS}}}Relationship"):
            assert relationship.get("TargetMode") != "External"
            target = relationship.get("Target")
            assert target is not None
            resolved = posixpath.normpath(posixpath.join(base_path, target))
            assert resolved in parts


def _assert_generated_content_types(workbook: ZipFile, *, sheet_count: int) -> None:
    root = ET.fromstring(workbook.read("[Content_Types].xml"))
    overrides = {
        element.get("PartName") for element in root.findall(f"{{{_CONTENT_TYPES_NS}}}Override")
    }
    for index in range(1, sheet_count + 1):
        assert f"/xl/worksheets/sheet{index}.xml" in overrides
        assert f"/xl/drawings/drawing{index}.xml" in overrides


def _zip_part(content: bytes, path: str) -> bytes:
    with ZipFile(BytesIO(content)) as workbook:
        return workbook.read(path)


def _rewrite_zip(
    content: bytes,
    *,
    replace: dict[str, bytes] | None = None,
    remove: str | None = None,
) -> bytes:
    replacements = replace or {}
    output = BytesIO()
    with ZipFile(BytesIO(content)) as source, ZipFile(output, "w", ZIP_DEFLATED) as target:
        for info in source.infolist():
            if info.filename == remove:
                continue
            target.writestr(info, replacements.get(info.filename, source.read(info.filename)))
    return output.getvalue()
