from datetime import date
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.api.dependencies import get_current_user
from app.core.database import get_db
from app.main import create_app
from app.models import Base
from app.models.enums import PersonType, ToolMaterialStatus, UserRole
from app.models.person import Person
from app.models.tool_material_item import ToolMaterialItem
from app.services.tool_material_service import ToolMaterialService


def app_user(role: UserRole, *permissions: str):
    return SimpleNamespace(
        id=7,
        role=role,
        is_active=True,
        must_change_password=False,
        office_page_permissions=list(permissions),
        person_id=None,
    )


def person_tool_material_db() -> tuple[Session, Person, Person]:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    db = Session(engine)
    target = Person(
        first_name="Anna",
        last_name="Bauer",
        display_name="Anna Bauer",
        short_code="AB",
        person_type=PersonType.INTERNAL,
        is_active=True,
    )
    other = Person(
        first_name="Berta",
        last_name="Claus",
        display_name="Berta Claus",
        short_code="BC",
        person_type=PersonType.INTERNAL,
        is_active=True,
    )
    db.add_all([target, other])
    db.flush()
    db.add_all(
        [
            ToolMaterialItem(
                beg_number="BEG-10",
                manufacturer="Bosch",
                designation="Bohrmaschine",
                employee_id=target.id,
                item_date=date(2026, 7, 10),
                status=ToolMaterialStatus.ISSUED,
            ),
            ToolMaterialItem(
                beg_number="BEG-2",
                manufacturer="Makita",
                designation="Säge",
                employee_id=target.id,
                item_date=date(2026, 7, 2),
                status=ToolMaterialStatus.ISSUED,
            ),
            ToolMaterialItem(
                beg_number="BEG-1",
                manufacturer="Hilti",
                designation="Fremdes Gerät",
                employee_id=other.id,
                status=ToolMaterialStatus.ISSUED,
            ),
            ToolMaterialItem(
                beg_number="LAGER-1",
                designation="Lagergerät",
                status=ToolMaterialStatus.WAREHOUSE,
            ),
            ToolMaterialItem(
                beg_number="AUSGEBUCHT-1",
                designation="Ausgebuchtes Gerät",
                status=ToolMaterialStatus.WRITTEN_OFF,
            ),
        ]
    )
    db.commit()
    db.refresh(target)
    db.refresh(other)
    return db, target, other


def test_service_lists_only_current_person_assignments_with_natural_beg_sorting():
    db, target, _other = person_tool_material_db()

    items = ToolMaterialService(db).list_person_assignments(target.id)

    assert [item.beg_number for item in items] == ["BEG-2", "BEG-10"]
    assert [item.designation for item in items] == ["Säge", "Bohrmaschine"]
    assert all(
        item.beg_number not in {"BEG-1", "LAGER-1", "AUSGEBUCHT-1"}
        for item in items
    )
    db.close()


def test_service_returns_empty_list_for_person_without_assignments():
    db, _target, _other = person_tool_material_db()
    unassigned = Person(
        first_name="Clara",
        last_name="Dahl",
        display_name="Clara Dahl",
        short_code="CD",
        person_type=PersonType.INTERNAL,
        is_active=True,
    )
    db.add(unassigned)
    db.commit()
    db.refresh(unassigned)

    assert ToolMaterialService(db).list_person_assignments(unassigned.id) == []
    db.close()


def test_person_tool_material_api_uses_reduced_response_schema():
    db, target, _other = person_tool_material_db()
    app = create_app()
    app.dependency_overrides[get_current_user] = lambda: app_user(UserRole.ADMIN)
    app.dependency_overrides[get_db] = lambda: db

    response = TestClient(app).get(f"/api/persons/{target.id}/tool-material-items")

    assert response.status_code == 200
    assert [item["beg_number"] for item in response.json()] == ["BEG-2", "BEG-10"]
    assert set(response.json()[0]) == {
        "beg_number",
        "manufacturer",
        "designation",
        "item_date",
    }
    assert "employee_id" not in response.json()[0]
    assert "status" not in response.json()[0]
    assert "serial_number" not in response.json()[0]
    app.dependency_overrides.clear()
    db.close()


@pytest.mark.parametrize(
    ("current_user", "expected_status"),
    [
        (app_user(UserRole.ADMIN), 200),
        (app_user(UserRole.PROJECT_MANAGER), 200),
        (app_user(UserRole.OFFICE, "employees"), 200),
        (app_user(UserRole.OFFICE, "overview"), 403),
        (app_user(UserRole.MONTEUR), 403),
    ],
)
def test_person_tool_material_api_keeps_employee_page_permissions(current_user, expected_status):
    db, target, _other = person_tool_material_db()
    app = create_app()
    app.dependency_overrides[get_current_user] = lambda: current_user
    app.dependency_overrides[get_db] = lambda: db

    response = TestClient(app).get(f"/api/persons/{target.id}/tool-material-items")

    assert response.status_code == expected_status
    app.dependency_overrides.clear()
    db.close()
