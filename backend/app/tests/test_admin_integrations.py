from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.api.dependencies import get_current_user
from app.api.routes import admin_ctrack, admin_integrations
from app.main import create_app
from app.models.enums import UserRole


def test_microsoft_graph_test_endpoint_requires_login():
    client = TestClient(create_app())

    response = client.get("/api/admin/integrations/microsoft-graph/test")

    assert response.status_code == 401


def test_microsoft_graph_test_endpoint_requires_admin_role():
    app = create_app()
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        id=2,
        role=UserRole.OFFICE,
        is_active=True,
    )
    client = TestClient(app)

    response = client.get("/api/admin/integrations/microsoft-graph/test")

    assert response.status_code == 403
    app.dependency_overrides.clear()


def test_microsoft_graph_test_endpoint_returns_disabled_state_for_admin(monkeypatch):
    class DisabledProjectStorageService:
        def test_project_storage_connection(self):
            return {
                "connected": False,
                "graph_enabled": False,
                "reason": "MS_GRAPH_ENABLED is false",
            }

    monkeypatch.setattr(admin_integrations, "ProjectStorageService", DisabledProjectStorageService)
    app = create_app()
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        id=1,
        role=UserRole.ADMIN,
        is_active=True,
    )
    client = TestClient(app)

    response = client.get("/api/admin/integrations/microsoft-graph/test")

    assert response.status_code == 200
    payload = response.json()
    assert payload["connected"] is False
    assert payload["graph_enabled"] is False
    assert payload["reason"] == "MS_GRAPH_ENABLED is false"
    assert payload["config_loaded"] is False
    assert payload["token_request_attempted"] is False
    assert payload["token_acquired"] is False
    assert payload["drive_check_attempted"] is False
    assert payload["root_folder_check_attempted"] is False
    assert payload["failed_step"] is None
    assert payload["drive"] is None
    assert payload["root_folder"] is None
    assert payload["site"] is None
    app.dependency_overrides.clear()


def test_microsoft_graph_backfill_endpoint_requires_admin_role():
    app = create_app()
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        id=2,
        role=UserRole.OFFICE,
        is_active=True,
    )
    client = TestClient(app)

    response = client.post("/api/admin/integrations/microsoft-graph/backfill-project-folders")

    assert response.status_code == 403
    app.dependency_overrides.clear()


def test_vehicle_latest_positions_are_visible_for_project_manager_and_office(monkeypatch):
    class DemoVehicleService:
        def __init__(self, _db):
            pass

        def list_latest_positions(self):
            return [
                {
                    "vehicle": {"id": 1, "label": "BEG 1"},
                    "position": {"latitude": 52.1, "longitude": 8.1},
                }
            ]

    monkeypatch.setattr(admin_ctrack, "CtrackVehicleSyncService", DemoVehicleService)
    for role in (UserRole.PROJECT_MANAGER, UserRole.OFFICE):
        app = create_app()
        app.dependency_overrides[get_current_user] = lambda role=role: SimpleNamespace(
            id=3,
            role=role,
            is_active=True,
        )
        client = TestClient(app)

        response = client.get("/api/vehicles/latest-positions")

        assert response.status_code == 200
        assert response.json()[0]["vehicle"]["label"] == "BEG 1"
        app.dependency_overrides.clear()


def test_vehicle_asset_management_stays_admin_only_for_office_user():
    app = create_app()
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        id=4,
        role=UserRole.OFFICE,
        is_active=True,
    )
    client = TestClient(app)

    response = client.get("/api/vehicles")

    assert response.status_code == 403
    app.dependency_overrides.clear()
