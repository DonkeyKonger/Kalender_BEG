from datetime import date

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models import Base
from app.models.enums import PersonType
from app.models.person import Person
from app.models.tool_material_item import ToolMaterialItem
from app.schemas.tool_material_item import ToolMaterialItemCreate, ToolMaterialListQuery
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
                item_date=date(2026, 7, 1),
                delivery_note="LS-001",
                stock=3,
            ),
            ToolMaterialItem(
                beg_number="BEG-002",
                manufacturer="Bosch",
                designation="Säge",
                employee_id=people["external"].id,
                item_date=date(2026, 7, 2),
                delivery_note="LS-002",
                stock=8,
            ),
            ToolMaterialItem(
                beg_number=None,
                manufacturer="Makita",
                designation="Altgerät",
                employee_id=people["inactive"].id,
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
    db.close()
