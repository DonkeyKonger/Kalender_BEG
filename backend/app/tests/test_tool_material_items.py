from datetime import date, datetime, timezone
from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.api.dependencies import get_current_user
from app.api.routes import tool_material_items
from app.core.database import get_db
from app.main import create_app
from app.models.enums import UserRole


def test_tool_material_items_require_admin_role():
    app = create_app()
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        id=2,
        role=UserRole.OFFICE,
        is_active=True,
    )
    app.dependency_overrides[get_db] = lambda: object()
    client = TestClient(app)

    response = client.get("/api/admin/tool-material-items")

    assert response.status_code == 403
    app.dependency_overrides.clear()


def test_tool_material_items_admin_crud_routes(monkeypatch):
    calls: list[tuple[str, object]] = []
    item = demo_tool_material_item()

    class DemoToolMaterialService:
        def __init__(self, _db):
            pass

        def list_items(self, search=None):
            calls.append(("list", search))
            return [item]

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
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        id=1,
        role=UserRole.ADMIN,
        is_active=True,
    )
    app.dependency_overrides[get_db] = lambda: object()
    client = TestClient(app)

    list_response = client.get("/api/admin/tool-material-items?search=bosch")
    create_response = client.post("/api/admin/tool-material-items", json={"designation": "Bohrmaschine"})
    update_response = client.patch("/api/admin/tool-material-items/7", json={"designation": "Bohrmaschine 2"})
    delete_response = client.delete("/api/admin/tool-material-items/7")

    assert list_response.status_code == 200
    assert list_response.json()[0]["designation"] == "Bohrmaschine"
    assert create_response.status_code == 201
    assert update_response.status_code == 200
    assert delete_response.status_code == 204
    assert calls == [
        ("list", "bosch"),
        ("create", "Bohrmaschine"),
        ("update", (7, "Bohrmaschine 2")),
        ("delete", 7),
    ]
    app.dependency_overrides.clear()


def demo_tool_material_item():
    timestamp = datetime(2026, 7, 11, 10, 0, tzinfo=timezone.utc)
    return SimpleNamespace(
        id=7,
        manufacturer="Bosch",
        designation="Bohrmaschine",
        item_type="GBH",
        device_number="G-100",
        serial_number="S-200",
        employee_id=3,
        employee=SimpleNamespace(id=3, display_name="Max Mustermann", short_code="MM"),
        item_date=date(2026, 7, 11),
        delivery_note="LS-1",
        remarks="Test",
        supplier="Lieferant",
        invoice_number="RG-1",
        stock=1,
        created_at=timestamp,
        updated_at=timestamp,
    )
