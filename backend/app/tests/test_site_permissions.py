from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.api.dependencies import get_current_user
from app.main import create_app
from app.models.enums import UserRole


def test_office_user_cannot_delete_site_via_direct_request():
    app = create_app()
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        id=2,
        role=UserRole.OFFICE,
        is_active=True,
        must_change_password=False,
    )

    try:
        response = TestClient(app).delete("/api/sites/123")
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 403
