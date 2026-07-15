from datetime import date

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models import Base
from app.models.enums import PersonType, ToolMaterialStatus
from app.models.person import Person
from app.models.tool_material_item import ToolMaterialItem
from app.schemas.tool_material_item import (
    ToolMaterialItemCreate,
    ToolMaterialItemUpdate,
    ToolMaterialListQuery,
)
from app.services.tool_material_service import EMPTY_FILTER_VALUE, ToolMaterialService


def tool_material_db() -> tuple[Session, dict[str, Person]]:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    db = Session(engine)
    people = {
        "internal": Person(
            first_name="Anna",
            last_name="Bauer",
            display_name="Anna Bauer",
            short_code="AB",
            person_type=PersonType.INTERNAL,
            is_active=True,
        ),
        "external": Person(
            first_name="Zeno",
            last_name="Extern",
            display_name="Zeno Extern",
            short_code="ZE",
            person_type=PersonType.EXTERNAL,
            is_active=True,
        ),
        "inactive": Person(
            first_name="Ina",
            last_name="Alt",
            display_name="Ina Alt",
            short_code="IA",
            person_type=PersonType.INTERNAL,
            is_active=False,
        ),
    }
    db.add_all(people.values())
    db.flush()
    db.add_all(
        [
            ToolMaterialItem(
                beg_number="BEG-001",
                manufacturer="Bosch",
                designation="Bohrmaschine",
                item_type="GBH",
                employee_id=people["internal"].id,
                status=ToolMaterialStatus.ISSUED,
                item_date=date(2026, 7, 1),
                delivery_note="LS-001",
                stock=3,
            ),
            ToolMaterialItem(
                beg_number="BEG-002",
                manufacturer="Bosch",
                designation="Säge",
                employee_id=people["external"].id,
                status=ToolMaterialStatus.ISSUED,
                item_date=date(2026, 7, 2),
                delivery_note="LS-002",
                stock=8,
            ),
            ToolMaterialItem(
                beg_number=None,
                manufacturer="Makita",
                designation="Altgerät",
                employee_id=people["inactive"].id,
                status=ToolMaterialStatus.ISSUED,
                item_date=None,
                stock=None,
            ),
        ]
    )
    db.commit()
    return db, people


def test_create_item_requires_and_persists_unique_beg_number():
    db, _people = tool_material_db()
    service = ToolMaterialService(db)

    created = service.create_item(
        ToolMaterialItemCreate(beg_number="  000-A  ", designation="Prüfgerät")
    )

    assert created.beg_number == "000-A"
    assert created.designation == "Prüfgerät"
    assert created.status == ToolMaterialStatus.WAREHOUSE
    db.close()


def test_duplicate_beg_number_is_rejected_case_insensitively():
    db, _people = tool_material_db()
    service = ToolMaterialService(db)

    with pytest.raises(HTTPException) as error:
        service.create_item(
            ToolMaterialItemCreate(beg_number="beg-001", designation="Duplikat")
        )

    assert error.value.status_code == 409
    assert error.value.detail == "Diese BEG-Nr. ist bereits vergeben."
    db.close()


def test_combined_column_filters_are_applied_server_side():
    db, people = tool_material_db()
    service = ToolMaterialService(db)

    items = service.list_items(
        ToolMaterialListQuery(
            filter_manufacturer="bosch",
            filter_designation="bohr",
            values_employee=[str(people["internal"].id)],
            stock_min=2,
            stock_max=4,
        )
    )

    assert [item.beg_number for item in items] == ["BEG-001"]
    db.close()


def test_global_search_combines_with_column_values_and_sorting():
    db, _people = tool_material_db()
    service = ToolMaterialService(db)

    items = service.list_items(
        ToolMaterialListQuery(
            search="LS-00",
            values_manufacturer=["Bosch"],
            sort_by="stock",
            sort_direction="desc",
        )
    )

    assert [item.beg_number for item in items] == ["BEG-002", "BEG-001"]
    db.close()


def test_filter_options_include_empty_values_and_inactive_assignments():
    db, people = tool_material_db()

    options = ToolMaterialService(db).filter_options().columns

    assert any(option.value == EMPTY_FILTER_VALUE for option in options["beg_number"])
    assert any(
        option.value == str(people["inactive"].id) and option.label == "Ina Alt"
        for option in options["employee"]
    )
    assert any(
        option.value == ToolMaterialStatus.ISSUED.value and option.label == "Ausgegeben"
        for option in options["status"]
    )
    db.close()


def test_all_status_values_can_be_created_and_updated():
    db, _people = tool_material_db()
    service = ToolMaterialService(db)

    item = service.create_item(
        ToolMaterialItemCreate(
            beg_number="STATUS-1",
            designation="Statusgerät",
            status=ToolMaterialStatus.ISSUED,
        )
    )
    assert item.status == ToolMaterialStatus.ISSUED

    for item_status in (ToolMaterialStatus.WAREHOUSE, ToolMaterialStatus.WRITTEN_OFF):
        item = service.update_item(
            item.id,
            ToolMaterialItemUpdate(status=item_status),
        )
        assert item.status == item_status
    db.close()


def test_status_filter_is_applied_server_side():
    db, _people = tool_material_db()
    service = ToolMaterialService(db)
    service.create_item(
        ToolMaterialItemCreate(
            beg_number="AUSGEBUCHT-1",
            designation="Ausgebuchtes Gerät",
            status=ToolMaterialStatus.WRITTEN_OFF,
        )
    )

    items = service.list_items(
        ToolMaterialListQuery(values_status=[ToolMaterialStatus.WRITTEN_OFF])
    )
    status_options = service.filter_options().columns["status"]

    assert [item.beg_number for item in items] == ["AUSGEBUCHT-1"]
    assert any(
        option.value == ToolMaterialStatus.WRITTEN_OFF.value
        and option.label == "Ausgebucht"
        for option in status_options
    )
    db.close()


def test_issued_item_can_be_created_with_employee_assignment():
    db, people = tool_material_db()

    item = ToolMaterialService(db).create_item(
        ToolMaterialItemCreate(
            beg_number="ASSIGN-1",
            designation="Ausgegebenes Gerät",
            employee_id=people["internal"].id,
        )
    )

    assert item.status == ToolMaterialStatus.ISSUED
    assert item.employee_id == people["internal"].id
    db.close()


@pytest.mark.parametrize(
    "target_status",
    [ToolMaterialStatus.WAREHOUSE, ToolMaterialStatus.WRITTEN_OFF],
)
def test_changing_issued_status_clears_employee_assignment(target_status):
    db, people = tool_material_db()
    service = ToolMaterialService(db)
    item = service.create_item(
        ToolMaterialItemCreate(
            beg_number=f"CLEAR-{target_status.value}",
            designation="Zuordnung entfernen",
            employee_id=people["internal"].id,
            status=ToolMaterialStatus.ISSUED,
        )
    )

    updated = service.update_item(
        item.id,
        ToolMaterialItemUpdate(status=target_status),
    )

    assert updated.status == target_status
    assert updated.employee_id is None
    db.close()


@pytest.mark.parametrize(
    "initial_status",
    [ToolMaterialStatus.WAREHOUSE, ToolMaterialStatus.WRITTEN_OFF],
)
def test_assigning_employee_changes_unassigned_status_to_issued(initial_status):
    db, people = tool_material_db()
    service = ToolMaterialService(db)
    item = service.create_item(
        ToolMaterialItemCreate(
            beg_number=f"ISSUE-{initial_status.value}",
            designation="Mitarbeiter zuordnen",
            status=initial_status,
        )
    )

    updated = service.update_item(
        item.id,
        ToolMaterialItemUpdate(employee_id=people["external"].id),
    )

    assert updated.status == ToolMaterialStatus.ISSUED
    assert updated.employee_id == people["external"].id
    db.close()


@pytest.mark.parametrize(
    "invalid_status",
    [ToolMaterialStatus.WAREHOUSE, ToolMaterialStatus.WRITTEN_OFF],
)
def test_backend_rejects_explicit_status_employee_contradictions(invalid_status):
    db, people = tool_material_db()
    service = ToolMaterialService(db)

    with pytest.raises(HTTPException) as create_error:
        service.create_item(
            ToolMaterialItemCreate(
                beg_number=f"INVALID-{invalid_status.value}",
                designation="Widerspruch",
                employee_id=people["internal"].id,
                status=invalid_status,
            )
        )

    assert create_error.value.status_code == 400

    existing = service.create_item(
        ToolMaterialItemCreate(
            beg_number=f"EDIT-{invalid_status.value}",
            designation="Bearbeitung",
            status=ToolMaterialStatus.WAREHOUSE,
        )
    )
    with pytest.raises(HTTPException) as update_error:
        service.update_item(
            existing.id,
            ToolMaterialItemUpdate(
                employee_id=people["internal"].id,
                status=invalid_status,
            ),
        )

    assert update_error.value.status_code == 400
    unchanged = service._get_item(existing.id)
    assert unchanged.status == ToolMaterialStatus.WAREHOUSE
    assert unchanged.employee_id is None
    db.close()
