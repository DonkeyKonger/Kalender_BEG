from datetime import timedelta
from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.api.routes import auth as auth_routes
from app.core.config import settings
from app.core.database import get_db
from app.core.security import create_access_token, decode_access_token
from app.main import create_app
from app.models.enums import UserRole


class FakeUserRepository:
    def __init__(self, _db):
        pass

    def get_by_id(self, user_id: int):
        return SimpleNamespace(id=user_id, role=UserRole.MONTEUR, is_active=True)


def test_refresh_token_accepts_recently_expired_token_with_configured_grace(monkeypatch):
    monkeypatch.setattr(settings, "access_token_refresh_grace_minutes", 5)
    monkeypatch.setattr(auth_routes, "UserRepository", FakeUserRepository)
    app = create_app()
    app.dependency_overrides[get_db] = lambda: object()
    client = TestClient(app)
    expired_token = create_access_token("7", expires_delta=timedelta(minutes=-1))

    response = client.post(
        "/api/auth/refresh",
        headers={"Authorization": f"Bearer {expired_token}"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["token_type"] == "bearer"
    assert payload["access_token"] != expired_token
    assert decode_access_token(payload["access_token"])["sub"] == "7"
    app.dependency_overrides.clear()


def test_refresh_token_rejects_expired_token_when_grace_is_disabled(monkeypatch):
    monkeypatch.setattr(settings, "access_token_refresh_grace_minutes", 0)
    monkeypatch.setattr(auth_routes, "UserRepository", FakeUserRepository)
    app = create_app()
    app.dependency_overrides[get_db] = lambda: object()
    client = TestClient(app)
    expired_token = create_access_token("7", expires_delta=timedelta(minutes=-1))

    response = client.post(
        "/api/auth/refresh",
        headers={"Authorization": f"Bearer {expired_token}"},
    )

    assert response.status_code == 401
    app.dependency_overrides.clear()
