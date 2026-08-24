from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.dependencies import get_current_user
from app.api.routes import sites
from app.core.database import get_db
from app.models.enums import UserRole
from app.schemas.extra_work import ExtraWorkTicketRead


def current_user(role: UserRole, *permissions: str) -> SimpleNamespace:
    return SimpleNamespace(
        id=7,
        role=role,
        person_id=None,
        is_active=True,
        must_change_password=False,
        office_page_permissions=list(permissions),
    )


def archived_ticket() -> ExtraWorkTicketRead:
    now = datetime.now(timezone.utc)
    return ExtraWorkTicketRead(
        id=12,
        site_id=8,
        sequence_number=2,
        display_number="8007.SZ02",
        title="Brandschott nacharbeiten",
        kind="billing",
        approval_ticket_id=None,
        status="signed",
        created_by_user_id=7,
        created_by_name="Max Monteur",
        submitted_by_user_id=7,
        submitted_at=now,
        notes="Abstimmung erfolgt.",
        manual_order_date=None,
        manual_execution_week=None,
        manual_execution_week_year=None,
        customer_signature_type="billing_customer",
        customer_signature_name="Kunde Beispiel",
        customer_signature_place="Bretten",
        customer_signed_at=now,
        worker_signature_name="Max Monteur",
        worker_signed_at=now,
        deleted_at=now,
        deleted_by_user_id=7,
        deleted_by_name="Archiv Admin",
        entry_count=1,
        photo_count=2,
        total_hours=2.5,
        estimated_hours=2.0,
        created_at=now,
        updated_at=now,
    )


class FakeExtraWorkService:
    calls: list[tuple] = []

    def __init__(self, _db) -> None:
        pass

    def list_site_tickets(
        self,
        site_id,
        *,
        archived_only=False,
        include_entry_summaries=False,
    ):
        self.calls.append(("list", site_id, archived_only, include_entry_summaries))
        return [archived_ticket()] if archived_only else []

    def delete_site_ticket(self, *, site_id, ticket_id, current_user):
        self.calls.append(("delete", site_id, ticket_id, current_user.id))

    def restore_site_ticket(self, *, site_id, ticket_id):
        self.calls.append(("restore", site_id, ticket_id))
        return archived_ticket().model_copy(
            update={
                "deleted_at": None,
                "deleted_by_user_id": None,
                "deleted_by_name": None,
            }
        )


def api_client(monkeypatch, user) -> TestClient:
    app = FastAPI()
    app.include_router(sites.router, prefix="/api")
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_db] = lambda: object()
    monkeypatch.setattr(sites, "ExtraWorkService", FakeExtraWorkService)
    FakeExtraWorkService.calls = []
    return TestClient(app)


def test_archive_list_forwards_archived_only_query(monkeypatch):
    response = api_client(monkeypatch, current_user(UserRole.OFFICE, "sites")).get(
        "/api/sites/8/extra-work-tickets?archived_only=true"
    )

    assert response.status_code == 200
    assert response.json()[0]["deleted_by_name"] == "Archiv Admin"
    assert FakeExtraWorkService.calls == [("list", 8, True, True)]


@pytest.mark.parametrize(
    "user",
    [
        current_user(UserRole.ADMIN),
        current_user(UserRole.PROJECT_MANAGER),
        current_user(UserRole.OFFICE, "sites"),
        current_user(UserRole.OFFICE, "calendar"),
    ],
)
def test_existing_write_roles_can_delete_and_restore_extra_work(monkeypatch, user):
    client = api_client(monkeypatch, user)

    delete_response = client.delete("/api/sites/8/extra-work-tickets/12")
    restore_response = client.post("/api/sites/8/extra-work-tickets/12/restore")

    assert delete_response.status_code == 204
    assert restore_response.status_code == 200
    assert restore_response.json()["id"] == 12
    assert restore_response.json()["deleted_at"] is None
    assert FakeExtraWorkService.calls == [
        ("delete", 8, 12, 7),
        ("restore", 8, 12),
    ]


@pytest.mark.parametrize(
    "user",
    [current_user(UserRole.OFFICE), current_user(UserRole.MONTEUR)],
)
def test_delete_and_restore_extra_work_require_existing_write_permission(monkeypatch, user):
    client = api_client(monkeypatch, user)

    assert client.delete("/api/sites/8/extra-work-tickets/12").status_code == 403
    assert client.post("/api/sites/8/extra-work-tickets/12/restore").status_code == 403
    assert FakeExtraWorkService.calls == []
