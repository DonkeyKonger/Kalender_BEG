from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.api.dependencies import get_current_user
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


def test_microsoft_graph_test_endpoint_returns_disabled_state_for_admin():
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
