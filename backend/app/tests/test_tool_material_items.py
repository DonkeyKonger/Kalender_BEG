from datetime import date, datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.api.dependencies import get_current_user
from app.api.routes import tool_material_items
from app.core.database import get_db
from app.main import create_app
from app.models import Base
from app.models.enums import PersonType, ToolMaterialStatus, UserRole
from app.models.person import Person
from app.models.tool_material_item import ToolMaterialItem
from app.schemas.tool_material_item import ToolMaterialFilterOptionsRead


def user(role: UserRole, *permissions: str):
    return SimpleNamespace(
        id=2,
        role=role,
        is_active=True,
        must_change_password=False,
        office_page_permissions=list(permissions),
    )


def test_tool_material_items_require_miscellaneous_opt_in_for_office():
    app = create_app()
    app.dependency_overrides[get_current_user] = lambda: user(UserRole.OFFICE)
    app.dependency_overrides[get_db] = lambda: object()
    client = TestClient(app)

    response = client.get("/api/admin/tool-material-items")

    assert response.status_code == 403
    app.dependency_overrides.clear()


@pytest.mark.parametrize(
    ("role", "permissions"),
    [
        (UserRole.ADMIN, ()),
        (UserRole.OFFICE, ("miscellaneous",)),
    ],
)
def test_tool_material_items_admin_and_opted_in_office_crud_routes(
    monkeypatch,
    role: UserRole,
    permissions: tuple[str, ...],
):
    calls: list[tuple[str, object]] = []
    item = demo_tool_material_item()

    class DemoToolMaterialService:
        def __init__(self, _db):
            pass

        def list_items(self, query=None):
            calls.append((
                "list",
                (
                    query.search,
                    query.filter_manufacturer,
                    query.values_manufacturer,
                    query.date_from,
                    query.stock_min,
                    query.values_status,
                    query.sort_by,
                    query.sort_direction,
                ),
            ))
            return [item]

        def filter_options(self):
            calls.append(("filter-options", None))
            return ToolMaterialFilterOptionsRead(columns={})

        def create_item(self, payload):
            calls.append(("create", payload.designation))
            return item

        def update_item(self, item_id, payload):
            calls.append(("update", (item_id, payload.designation)))
            return item

        def delete_item(self, item_id):
            calls.append(("delete", item_id))

    monkeypatch.setattr(tool_material_items, "ToolMaterialService", DemoToolMaterialService)
    app = create_app()
    app.dependency_overrides[get_current_user] = lambda: user(role, *permissions)
    app.dependency_overrides[get_db] = lambda: object()
    client = TestClient(app)

    list_response = client.get(
        "/api/admin/tool-material-items"
        "?search=bosch"
        "&filter_manufacturer=Bosch"
        "&values_manufacturer=Bosch"
        "&values_manufacturer=Makita"
        "&date_from=2026-01-01"
        "&stock_min=1"
        "&values_status=issued"
        "&sort_by=beg_number"
        "&sort_direction=desc"
    )
    filter_options_response = client.get("/api/admin/tool-material-items/filter-options")
    create_response = client.post(
        "/api/admin/tool-material-items",
        json={"beg_number": "BEG-007", "designation": "Bohrmaschine"},
    )
    update_response = client.patch("/api/admin/tool-material-items/7", json={"designation": "Bohrmaschine 2"})
    invalid_status_response = client.post(
        "/api/admin/tool-material-items",
        json={"beg_number": "BEG-008", "designation": "Ungültig", "status": "frei erfunden"},
    )
    delete_response = client.delete("/api/admin/tool-material-items/7")

    assert list_response.status_code == 200
    assert filter_options_response.status_code == 200
    assert list_response.json()[0]["designation"] == "Bohrmaschine"
    assert create_response.status_code == 201
    assert update_response.status_code == 200
    assert invalid_status_response.status_code == 422
    assert delete_response.status_code == 204
    assert calls == [
        (
            "list",
            (
                "bosch",
                "Bosch",
                ["Bosch", "Makita"],
                date(2026, 1, 1),
                1,
                ["issued"],
                "beg_number",
                "desc",
            ),
        ),
        ("filter-options", None),
        ("create", "Bohrmaschine"),
        ("update", (7, "Bohrmaschine 2")),
        ("delete", 7),
    ]
    app.dependency_overrides.clear()


@pytest.mark.parametrize(
    "current_user",
    [
        user(UserRole.OFFICE),
        user(UserRole.PROJECT_MANAGER, "miscellaneous"),
        user(UserRole.MONTEUR, "miscellaneous"),
    ],
)
@pytest.mark.parametrize(
    ("method", "path", "payload"),
    [
        ("get", "/api/admin/tool-material-items", None),
        ("get", "/api/admin/tool-material-items/filter-options", None),
        (
            "post",
            "/api/admin/tool-material-items",
            {"beg_number": "DENIED", "designation": "Gesperrt"},
        ),
        (
            "patch",
            "/api/admin/tool-material-items/7",
            {"status": "warehouse"},
        ),
        ("delete", "/api/admin/tool-material-items/7", None),
    ],
)
def test_tool_material_endpoints_reject_users_without_miscellaneous_access(
    current_user,
    method: str,
    path: str,
    payload,
):
    app = create_app()
    app.dependency_overrides[get_current_user] = lambda: current_user
    app.dependency_overrides[get_db] = lambda: object()

    response = TestClient(app).request(method, path, json=payload)

    assert response.status_code == 403
    app.dependency_overrides.clear()


def test_tool_material_api_rejects_contradictory_status_and_employee():
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    db = Session(engine)
    employee = Person(
        first_name="Anna",
        last_name="Bauer",
        display_name="Anna Bauer",
        short_code="AB",
        person_type=PersonType.INTERNAL,
        is_active=True,
    )
    db.add(employee)
    db.commit()
    db.refresh(employee)

    app = create_app()
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        id=1,
        role=UserRole.ADMIN,
        is_active=True,
    )
    app.dependency_overrides[get_db] = lambda: db
    client = TestClient(app)

    response = client.post(
        "/api/admin/tool-material-items",
        json={
            "beg_number": "INVALID-API",
            "designation": "Widerspruch",
            "employee_id": employee.id,
            "status": "warehouse",
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"] == (
        "Lager- oder defekte Einträge dürfen keinem Mitarbeiter zugeordnet sein."
    )
    assert db.scalar(select(ToolMaterialItem.id)) is None
    app.dependency_overrides.clear()
    db.close()


@pytest.mark.parametrize("target_status", ["warehouse", "defective"])
@pytest.mark.parametrize(
    ("role", "permissions"),
    [
        (UserRole.ADMIN, ()),
        (UserRole.OFFICE, ("miscellaneous",)),
    ],
)
def test_tool_material_api_status_change_clears_employee_assignment(
    target_status,
    role: UserRole,
    permissions: tuple[str, ...],
):
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    db = Session(engine)
    employee = Person(
        first_name="Anna",
        last_name="Bauer",
        display_name="Anna Bauer",
        short_code="AB",
        person_type=PersonType.INTERNAL,
        is_active=True,
    )
    item = ToolMaterialItem(
        beg_number=f"INLINE-{target_status}",
        designation="Status direkt ändern",
        employee=employee,
        status=ToolMaterialStatus.ISSUED,
    )
    db.add(item)
    db.commit()
    db.refresh(item)

    app = create_app()
    app.dependency_overrides[get_current_user] = lambda: user(role, *permissions)
    app.dependency_overrides[get_db] = lambda: db
    response = TestClient(app).patch(
        f"/api/admin/tool-material-items/{item.id}",
        json={"status": target_status},
    )

    assert response.status_code == 200
    assert response.json()["status"] == target_status
    assert response.json()["employee_id"] is None
    assert response.json()["employee"] is None
    db.expire_all()
    stored_item = db.get(ToolMaterialItem, item.id)
    assert stored_item is not None
    assert stored_item.employee_id is None
    app.dependency_overrides.clear()
    db.close()


def demo_tool_material_item():
    timestamp = datetime(2026, 7, 11, 10, 0, tzinfo=timezone.utc)
    return SimpleNamespace(
        id=7,
        beg_number="BEG-007",
        manufacturer="Bosch",
        designation="Bohrmaschine",
        item_type="GBH",
        device_number="G-100",
        serial_number="S-200",
        employee_id=3,
        employee=SimpleNamespace(
            id=3,
            display_name="Max Mustermann",
            short_code="MM",
            person_type="internal",
            is_active=True,
        ),
        item_date=date(2026, 7, 11),
        delivery_note="LS-1",
        remarks="Test",
        supplier="Lieferant",
        invoice_number="RG-1",
        stock=1,
        status="warehouse",
        created_at=timestamp,
        updated_at=timestamp,
    )
