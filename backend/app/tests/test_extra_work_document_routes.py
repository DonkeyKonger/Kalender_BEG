from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.dependencies import get_current_user
from app.api.routes import sites
from app.core.database import get_db
from app.models.enums import UserRole
from app.schemas.extra_work import (
    ExtraWorkTicketDocumentCustomerSignatureRead,
    ExtraWorkTicketDocumentDatesRead,
    ExtraWorkTicketDocumentRead,
    ExtraWorkTicketDocumentWorkerSignatureRead,
    ExtraWorkTicketPhotoRead,
    ExtraWorkTicketRead,
)


def current_user(role: UserRole, *permissions: str) -> SimpleNamespace:
    return SimpleNamespace(
        id=7,
        role=role,
        person_id=None,
        is_active=True,
        must_change_password=False,
        office_page_permissions=list(permissions),
    )


def ticket_read() -> ExtraWorkTicketRead:
    now = datetime.now(timezone.utc)
    return ExtraWorkTicketRead(
        id=12,
        site_id=8,
        sequence_number=2,
        display_number="8015.SZ02",
        title="Brandschott",
        kind="billing",
        approval_ticket_id=None,
        status="draft",
        created_by_user_id=7,
        created_by_name="Büro Test",
        submitted_by_user_id=None,
        submitted_at=None,
        notes=None,
        manual_order_date=None,
        manual_execution_week=None,
        manual_execution_week_year=None,
        customer_signature_type=None,
        customer_signature_name=None,
        customer_signature_place=None,
        customer_signed_at=None,
        worker_signature_name=None,
        worker_signed_at=None,
        entry_count=0,
        photo_count=0,
        total_hours=0,
        estimated_hours=None,
        created_at=now,
        updated_at=now,
    )


def document_read(ticket: ExtraWorkTicketRead | None = None) -> ExtraWorkTicketDocumentRead:
    today = datetime.now(timezone.utc).date()
    return ExtraWorkTicketDocumentRead(
        ticket=ticket or ticket_read(),
        entry=None,
        resolved_dates=ExtraWorkTicketDocumentDatesRead(
            order_date=today,
            approval_date=today,
            approval_place=None,
            execution_start=today,
            execution_end=today,
        ),
        worker_signature=ExtraWorkTicketDocumentWorkerSignatureRead(
            name=None,
            signed_at=None,
            strokes=None,
        ),
        customer_signature=ExtraWorkTicketDocumentCustomerSignatureRead(
            type=None,
            name=None,
            place=None,
            signed_at=None,
            strokes=None,
        ),
    )


def photo_read() -> ExtraWorkTicketPhotoRead:
    now = datetime.now(timezone.utc)
    return ExtraWorkTicketPhotoRead(
        id=4,
        site_id=8,
        extra_work_ticket_id=12,
        filename="baustelle.jpg",
        content_type="image/jpeg",
        file_size_bytes=128,
        external_web_url=None,
        uploaded_by_name="Büro Test",
        taken_at=None,
        created_at=now,
        updated_at=now,
    )


class FakeExtraWorkService:
    calls: list[tuple] = []

    def __init__(self, _db) -> None:
        pass

    def _get_site(self, site_id):
        self.calls.append(("site", site_id))
        return SimpleNamespace(id=site_id)

    def create_site_ticket(self, *, site_id, current_user, payload):
        self.calls.append(("create", site_id, current_user.id, payload.model_dump()))
        return ticket_read()

    def get_site_ticket_document(self, *, site_id, ticket_id, include_deleted=False):
        self.calls.append(("get-document", site_id, ticket_id, include_deleted))
        return document_read()

    def update_site_ticket_document(self, *, site_id, ticket_id, current_user, payload):
        self.calls.append(
            ("put-document", site_id, ticket_id, current_user.id, payload.title)
        )
        return document_read(
            ticket_read().model_copy(update={"title": payload.title})
        )

    def list_site_ticket_photos(self, *, site_id, ticket_id, include_deleted=False):
        self.calls.append(("photos", site_id, ticket_id, include_deleted))
        return []

    def upload_site_ticket_photo(
        self,
        *,
        site_id,
        ticket_id,
        current_user,
        filename,
        content,
        content_type,
    ):
        self.calls.append(
            (
                "upload-photo",
                site_id,
                ticket_id,
                current_user.id,
                filename,
                content,
                content_type,
            )
        )
        return photo_read()

    def get_site_ticket_photo_content(
        self,
        *,
        site_id,
        ticket_id,
        photo_id,
        current_user,
        include_deleted=False,
    ):
        self.calls.append(
            (
                "photo-content",
                site_id,
                ticket_id,
                photo_id,
                current_user.id,
                include_deleted,
            )
        )
        return b"photo", "image/jpeg", "baustelle.jpg"

    def get_site_ticket_photo_thumbnail(
        self,
        *,
        site_id,
        ticket_id,
        photo_id,
        current_user,
        include_deleted=False,
    ):
        self.calls.append(
            (
                "photo-thumbnail",
                site_id,
                ticket_id,
                photo_id,
                current_user.id,
                include_deleted,
            )
        )
        return b"thumbnail", "image/jpeg"

    def delete_site_ticket_photo(
        self,
        *,
        site_id,
        ticket_id,
        photo_id,
        current_user,
    ):
        self.calls.append(
            ("delete-photo", site_id, ticket_id, photo_id, current_user.id)
        )


class FakeExtraWorkPdfService:
    calls: list[tuple] = []

    def __init__(self, _db) -> None:
        pass

    def build_clean_template_pdf(self):
        self.calls.append(("template",))
        return b"%PDF-clean-template"


def api_client(monkeypatch, user) -> TestClient:
    app = FastAPI()
    app.include_router(sites.router, prefix="/api")
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_db] = lambda: object()
    monkeypatch.setattr(sites, "ExtraWorkService", FakeExtraWorkService)
    monkeypatch.setattr(sites, "ExtraWorkPdfService", FakeExtraWorkPdfService)
    FakeExtraWorkService.calls = []
    FakeExtraWorkPdfService.calls = []
    return TestClient(app)


@pytest.mark.parametrize(
    "user",
    [
        current_user(UserRole.ADMIN),
        current_user(UserRole.PROJECT_MANAGER),
        current_user(UserRole.OFFICE, "sites"),
    ],
)
def test_site_ticket_create_and_document_put_require_sites_write(monkeypatch, user):
    client = api_client(monkeypatch, user)

    created = client.post("/api/sites/8/extra-work-tickets", json={})
    updated = client.put(
        "/api/sites/8/extra-work-tickets/12/document",
        json={"title": "Geändert"},
    )

    assert created.status_code == 201
    assert updated.status_code == 200
    assert updated.json()["ticket"]["title"] == "Geändert"
    assert FakeExtraWorkService.calls == [
        ("create", 8, 7, {"title": None, "kind": None, "approval_ticket_id": None, "notes": None}),
        ("put-document", 8, 12, 7, "Geändert"),
    ]


@pytest.mark.parametrize(
    "user",
    [current_user(UserRole.OFFICE)],
)
def test_office_without_page_permission_cannot_create_or_update_site_ticket(monkeypatch, user):
    client = api_client(monkeypatch, user)

    assert client.post("/api/sites/8/extra-work-tickets", json={}).status_code == 403
    assert (
        client.put(
            "/api/sites/8/extra-work-tickets/12/document",
            json={"title": "Nicht erlaubt"},
        ).status_code
        == 403
    )
    assert FakeExtraWorkService.calls == []


def test_calendar_only_office_keeps_legacy_create_but_cannot_update_document(monkeypatch):
    client = api_client(monkeypatch, current_user(UserRole.OFFICE, "calendar"))

    created = client.post("/api/sites/8/extra-work-tickets", json={})
    updated = client.put(
        "/api/sites/8/extra-work-tickets/12/document",
        json={"title": "Nicht erlaubt"},
    )

    assert created.status_code == 201
    assert updated.status_code == 403
    assert FakeExtraWorkService.calls == [
        (
            "create",
            8,
            7,
            {"title": None, "kind": None, "approval_ticket_id": None, "notes": None},
        )
    ]


@pytest.mark.parametrize(
    "user",
    [
        current_user(UserRole.ADMIN),
        current_user(UserRole.PROJECT_MANAGER),
        current_user(UserRole.OFFICE, "sites"),
    ],
)
def test_site_photo_upload_and_delete_require_sites_write(monkeypatch, user):
    client = api_client(monkeypatch, user)

    uploaded = client.post(
        "/api/sites/8/extra-work-tickets/12/photos",
        files={"file": ("baustelle.png", b"image-content", "image/png")},
    )
    deleted = client.delete("/api/sites/8/extra-work-tickets/12/photos/4")

    assert uploaded.status_code == 201
    assert uploaded.json()["filename"] == "baustelle.jpg"
    assert deleted.status_code == 204
    assert FakeExtraWorkService.calls == [
        (
            "upload-photo",
            8,
            12,
            7,
            "baustelle.png",
            b"image-content",
            "image/png",
        ),
        ("delete-photo", 8, 12, 4, 7),
    ]


@pytest.mark.parametrize(
    "user",
    [
        current_user(UserRole.OFFICE),
        current_user(UserRole.OFFICE, "calendar"),
    ],
)
def test_site_photo_mutations_reject_users_without_sites_write(monkeypatch, user):
    client = api_client(monkeypatch, user)

    uploaded = client.post(
        "/api/sites/8/extra-work-tickets/12/photos",
        files={"file": ("baustelle.png", b"image-content", "image/png")},
    )
    deleted = client.delete("/api/sites/8/extra-work-tickets/12/photos/4")

    assert uploaded.status_code == 403
    assert deleted.status_code == 403
    assert FakeExtraWorkService.calls == []


def test_read_routes_forward_archive_flags_and_serve_sanitized_template(monkeypatch):
    client = api_client(monkeypatch, current_user(UserRole.OFFICE, "payroll"))

    document = client.get(
        "/api/sites/8/extra-work-tickets/12/document?include_deleted=true"
    )
    photos = client.get(
        "/api/sites/8/extra-work-tickets/12/photos?include_deleted=true"
    )
    photo = client.get(
        "/api/sites/8/extra-work-tickets/12/photos/4/content?include_deleted=true"
    )
    thumbnail = client.get(
        "/api/sites/8/extra-work-tickets/12/photos/4/thumbnail?include_deleted=true"
    )
    cached_thumbnail = client.get(
        "/api/sites/8/extra-work-tickets/12/photos/4/thumbnail?include_deleted=true",
        headers={"If-None-Match": thumbnail.headers["etag"]},
    )
    template = client.get("/api/sites/8/extra-work-template")

    assert document.status_code == 200
    assert document.json()["entry"] is None
    assert photos.status_code == 200 and photos.json() == []
    assert photo.status_code == 200 and photo.content == b"photo"
    assert photo.headers["content-type"] == "image/jpeg"
    assert thumbnail.status_code == 200 and thumbnail.content == b"thumbnail"
    assert thumbnail.headers["content-type"] == "image/jpeg"
    assert thumbnail.headers["cache-control"] == "private, max-age=86400, immutable"
    assert cached_thumbnail.status_code == 304
    assert template.status_code == 200
    assert template.headers["content-type"] == "application/pdf"
    assert template.content == b"%PDF-clean-template"
    assert FakeExtraWorkService.calls == [
        ("get-document", 8, 12, True),
        ("photos", 8, 12, True),
        ("photo-content", 8, 12, 4, 7, True),
        ("photo-thumbnail", 8, 12, 4, 7, True),
        ("photo-thumbnail", 8, 12, 4, 7, True),
        ("site", 8),
    ]
    assert FakeExtraWorkPdfService.calls == [("template",)]
