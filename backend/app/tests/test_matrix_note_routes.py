from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.api.dependencies import get_current_user
from app.api.routes import matrix
from app.core.database import get_db
from app.main import create_app
from app.models.enums import UserRole


def test_matrix_site_notes_use_calendar_permission_and_site_scope(monkeypatch):
    calls: list[tuple[int, bool | None]] = []

    class DemoDashboardNoteService:
        def __init__(self, _db):
            pass

        def list_site_notes(self, *, site_id, completed=None):
            calls.append((site_id, completed))
            return []

    monkeypatch.setattr(matrix, "DashboardNoteService", DemoDashboardNoteService)
    app = create_app()
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        id=2,
        role=UserRole.OFFICE,
        is_active=True,
        office_page_permissions=["calendar"],
    )
    app.dependency_overrides[get_db] = lambda: object()

    response = TestClient(app).get("/api/matrix/sites/8018/notes?completed=false")

    assert response.status_code == 200
    assert response.json() == []
    assert calls == [(8018, False)]
    app.dependency_overrides.clear()


def test_matrix_site_notes_reject_office_user_without_calendar_permission(monkeypatch):
    class UnexpectedDashboardNoteService:
        def __init__(self, _db):
            raise AssertionError("Service darf ohne Kalenderberechtigung nicht aufgerufen werden.")

    monkeypatch.setattr(matrix, "DashboardNoteService", UnexpectedDashboardNoteService)
    app = create_app()
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        id=2,
        role=UserRole.OFFICE,
        is_active=True,
        office_page_permissions=["overview"],
    )
    app.dependency_overrides[get_db] = lambda: object()

    response = TestClient(app).get("/api/matrix/sites/8018/notes")

    assert response.status_code == 403
    app.dependency_overrides.clear()
