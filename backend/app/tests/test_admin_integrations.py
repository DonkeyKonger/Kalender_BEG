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
    assert response.json() == {
        "connected": False,
        "graph_enabled": False,
        "reason": "MS_GRAPH_ENABLED is false",
        "status_code": None,
        "missing_config": [],
        "drive": None,
        "root_folder": None,
        "site": None,
    }
    app.dependency_overrides.clear()
