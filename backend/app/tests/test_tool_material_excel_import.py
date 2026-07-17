from datetime import date
from decimal import Decimal
import hashlib
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models import Base
from app.models.enums import PersonType, ToolMaterialStatus
from app.models.person import Person
from app.models.tool_material_item import ToolMaterialItem
from app.scripts.import_bundled_tools import EXPECTED_SHA256
from app.services.tool_material_excel_import import (
    ExcelCell,
    ImportReport,
    SourceToolRow,
    ToolMaterialExcelImporter,
    deduplicate_source_rows,
    excel_date,
    identifier_text,
    is_exact_numeric_one,
    read_source_rows,
    stable_source_key,
    verify_applied_import,
)


def make_row(
    row_number: int,
    *,
    beg_number: str | None,
    designation: str,
    employee: str | None = "BEG",
    item_date: date | None = date(2026, 1, 1),
    device_number: str | None = None,
    serial_number: str | None = None,
    remarks: str | None = None,
) -> SourceToolRow:
    return SourceToolRow(
        row_number=row_number,
        beg_number=beg_number,
        manufacturer="Bosch",
        designation=designation,
        item_type="Typ",
        device_number=device_number,
        serial_number=serial_number,
        employee_value=employee,
        item_date=item_date,
        delivery_note="LS-1",
        remarks=remarks,
        supplier="Lieferant",
        invoice_number="RG-1",
        stock=1,
        import_key=stable_source_key(row_number),
    )


def import_db(*people: Person) -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    db = Session(engine)
    db.add_all(people)
    db.commit()
    return db


def test_identifier_values_never_use_exponent_or_dot_zero_and_keep_zero_format():
    assert identifier_text(ExcelCell(Decimal("813491218500234151"), True)) == "813491218500234151"
    assert identifier_text(ExcelCell(Decimal("29009664"), True, "000000000")) == "029009664"
    assert identifier_text(ExcelCell(Decimal("8"), True)) == "8"
    assert identifier_text(ExcelCell("08/2024")) == "08/2024"
    assert excel_date(ExcelCell(Decimal("46174"), True, "__date__")) == date(2026, 6, 1)


def test_stock_filter_accepts_only_the_exact_numeric_value_one():
    assert is_exact_numeric_one(ExcelCell(Decimal("1"), True)) is True
    assert is_exact_numeric_one(ExcelCell(Decimal("1.0"), True)) is True
    assert is_exact_numeric_one(ExcelCell("1")) is False
    assert is_exact_numeric_one(ExcelCell(True)) is False
    assert is_exact_numeric_one(ExcelCell(Decimal("2"), True)) is False


def test_bundled_productive_snapshot_matches_all_source_controls():
    source_file = (
        Path(__file__).parents[1]
        / "import_data"
        / "BEG-Maschinen+Werkzeugliste.xlsx"
    )
    digest = hashlib.sha256(source_file.read_bytes()).hexdigest()

    rows, report = read_source_rows(source_file)

    assert digest == EXPECTED_SHA256
    assert report.errors == []
    assert report.stock_one_rows == 902
    assert report.valid_source_rows == 900
    assert len(report.invalid_rows) == 2
    assert report.physical_tool_rows == 898
    assert report.unnumbered_rows == 33
    assert report.company_stock_rows == 281
    assert len(report.duplicate_groups) == 2
    assert len(rows) == 898


def test_duplicate_physical_tools_select_newest_assignment():
    report = ImportReport(mode="test", file="fixture.xlsx")
    older = make_row(
        10,
        beg_number="25081",
        designation="Akku",
        employee="König",
        item_date=date(2026, 5, 4),
        device_number="1607A350ZK",
        serial_number="529010362",
    )
    newer = make_row(
        11,
        beg_number="25081",
        designation="Akku",
        employee="Salzen",
        item_date=date(2026, 6, 1),
        device_number="1607A350ZK",
        serial_number="529010362",
    )

    rows = deduplicate_source_rows([older, newer], report)

    assert len(rows) == 1
    assert rows[0].employee_value == "Salzen"
    assert report.duplicate_groups[0]["source_rows"] == [10, 11]


def test_import_preserves_same_beg_components_and_unnumbered_source_rows():
    db = import_db()
    rows = [
        make_row(2, beg_number="20000", designation="Bohrhammer", serial_number="A"),
        make_row(3, beg_number="20000", designation="Akku", serial_number="B"),
        make_row(4, beg_number=None, designation="Wasserwaage"),
        make_row(5, beg_number=None, designation="Wasserwaage"),
    ]
    report = ImportReport(mode="test", file="fixture.xlsx", physical_tool_rows=4)
    importer = ToolMaterialExcelImporter(db, rows, report)
    plans = importer.plan()
    importer.apply(plans)
    db.commit()

    items = db.query(ToolMaterialItem).order_by(ToolMaterialItem.id).all()
    assert len(items) == 4
    assert [item.beg_number for item in items].count("20000") == 2
    assert len({item.import_key for item in items if item.beg_number is None}) == 2
    db.close()


def test_employee_mapping_uses_person_id_and_import_is_idempotent():
    salzen = Person(
        first_name="Detlef",
        last_name="von Salzen",
        display_name="Detlef von Salzen",
        short_code="DS",
        person_type=PersonType.INTERNAL,
        is_active=False,
    )
    db = import_db(salzen)
    row = make_row(
        20,
        beg_number="25081",
        designation="Akku",
        employee="Salzen",
        item_date=date(2026, 6, 1),
        device_number="1607A350ZK",
        serial_number="529010362",
    )
    first_report = ImportReport(mode="test", file="fixture.xlsx", physical_tool_rows=1)
    first = ToolMaterialExcelImporter(db, [row], first_report)
    first.apply(first.plan())
    db.commit()

    item = db.query(ToolMaterialItem).one()
    assert item.employee_id == salzen.id
    assert item.status == ToolMaterialStatus.ISSUED

    second_report = ImportReport(mode="test", file="fixture.xlsx", physical_tool_rows=1)
    second = ToolMaterialExcelImporter(db, [row], second_report)
    second_plans = second.plan()
    assert second_report.creates == 0
    assert second_report.updates == 0
    assert second_report.unchanged == 1
    assert second_plans[0][0] == "unchanged"
    db.close()


def test_existing_operational_state_newer_assignment_and_manual_remarks_win():
    current = Person(
        first_name="Aktuell",
        last_name="Mitarbeiter",
        display_name="Aktuell Mitarbeiter",
        short_code="AM",
        person_type=PersonType.INTERNAL,
        is_active=True,
    )
    historical = Person(
        first_name="Sandro",
        last_name="König",
        display_name="Sandro König",
        short_code="SK",
        person_type=PersonType.INTERNAL,
        is_active=True,
    )
    db = import_db(current, historical)
    existing = ToolMaterialItem(
        beg_number="42",
        designation="Bohrhammer",
        manufacturer=None,
        employee_id=current.id,
        item_date=date(2026, 7, 1),
        remarks="Manuell ergänzt",
        status=ToolMaterialStatus.ISSUED,
    )
    db.add(existing)
    db.commit()
    row = make_row(
        42,
        beg_number="42",
        designation="Bohrhammer",
        employee="König",
        item_date=date(2026, 6, 1),
        remarks="Alte Excel-Bemerkung",
    )
    report = ImportReport(mode="test", file="fixture.xlsx", physical_tool_rows=1)
    importer = ToolMaterialExcelImporter(db, [row], report)
    importer.apply(importer.plan())
    db.commit()

    db.refresh(existing)
    assert existing.manufacturer == "Bosch"
    assert existing.employee_id == current.id
    assert existing.item_date == date(2026, 7, 1)
    assert existing.status == ToolMaterialStatus.ISSUED
    assert existing.remarks == "Manuell ergänzt"
    db.close()


def test_special_locations_are_unassigned_and_unresolved_people_block_apply():
    db = import_db()
    rows = [
        make_row(60, beg_number="60", designation="Gerät", employee="Wohnung HH"),
        make_row(61, beg_number="61", designation="Gerät", employee="Nicht vorhanden"),
    ]
    report = ImportReport(mode="test", file="fixture.xlsx", physical_tool_rows=2)
    importer = ToolMaterialExcelImporter(db, rows, report)
    plans = importer.plan()

    assert report.unresolved_employees[0]["source_value"] == "Nicht vorhanden"
    assert report.blockers
    wohnung_values = next(values for action, row, _item, values in plans if row.row_number == 60)
    assert wohnung_values["employee_id"] is None
    assert wohnung_values["status"] == ToolMaterialStatus.WAREHOUSE
    assert "Wohnung HH" in wohnung_values["remarks"]
    db.close()


def test_full_control_set_is_verified_as_idempotent_before_commit():
    db = import_db()
    rows = [
        make_row(
            100 + index,
            beg_number="20000",
            designation=f"Komponente {index}",
            serial_number=f"SET-{index}",
        )
        for index in range(6)
    ]
    rows.extend(
        make_row(200 + index, beg_number=None, designation=f"Unnummeriert {index}")
        for index in range(33)
    )
    rows.extend(
        [
            make_row(
                300,
                beg_number="25081",
                designation="Akku",
                device_number="1607A350ZK",
                serial_number="529010362",
            ),
            make_row(
                301,
                beg_number="25083",
                designation="Akku",
                device_number="1607A350ZK",
                serial_number="527270128",
            ),
        ]
    )
    rows.extend(
        make_row(
            400 + index,
            beg_number=str(30000 + index),
            designation=f"Werkzeug {index}",
            serial_number=f"SER-{index}",
        )
        for index in range(857)
    )
    assert len(rows) == 898
    report = ImportReport(mode="apply", file="fixture.xlsx", physical_tool_rows=898)
    importer = ToolMaterialExcelImporter(db, rows, report)
    plans = importer.plan()
    importer.apply(plans)

    verify_applied_import(db, rows, report)
    db.commit()

    assert report.control_checks["post_import_source_keys"]["ok"] is True
    assert report.control_checks["idempotency_new_creates"]["actual"] == 0
    assert report.control_checks["idempotency_updates"]["actual"] == 0
    assert db.query(ToolMaterialItem).count() == 898
    db.close()
