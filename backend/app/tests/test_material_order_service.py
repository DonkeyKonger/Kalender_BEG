from __future__ import annotations

from datetime import UTC, datetime
from io import BytesIO
from urllib.parse import unquote

import pytest
from fastapi import HTTPException
from pypdf import PdfReader, PdfWriter
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.models import Base
from app.models.material_order import MaterialOrderDraft
from app.models.site import Site
from app.models.user import User
from app.models.enums import UserRole
from app.schemas.material_order import MaterialOrderValuesUpdate
from app.services.material_order_service import (
    MaterialOrderService,
    _base_filename,
    _filename_number,
    _numbered_filename,
)
from app.services.microsoft_graph_client import MicrosoftGraphRequestError


FORM = {
    "width": 595.0,
    "height": 842.0,
    "fields": [
        {"name": "customer", "label": "Kunde", "type": "text", "rect": [1, 1, 2, 2], "max_length": 120},
        {"name": "project", "label": "Projekt", "type": "text", "rect": [1, 1, 2, 2], "max_length": 120},
        {"name": "commission", "label": "Kommission", "type": "text", "rect": [1, 1, 2, 2], "max_length": 60},
        {"name": "requested_by", "label": "Angemeldet von", "type": "text", "rect": [1, 1, 2, 2], "max_length": 80},
        {"name": "material_1", "label": "Material", "type": "text", "rect": [1, 1, 2, 2], "max_length": 180},
        {"name": "quantity_1", "label": "Stück", "type": "text", "rect": [1, 1, 2, 2], "max_length": 32},
        {"name": "packed_1", "label": "Gepackt", "type": "checkbox", "rect": [1, 1, 2, 2], "max_length": None},
    ],
}


def pdf_bytes() -> bytes:
    writer = PdfWriter()
    writer.add_blank_page(width=595, height=842)
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


def validate(values: dict[str, str | bool]) -> None:
    specs = {field["name"]: field for field in FORM["fields"]}
    for name, value in values.items():
        if name not in specs:
            raise ValueError(f"Unbekanntes Formularfeld: {name}")
        spec = specs[name]
        if spec["type"] == "text" and not isinstance(value, str):
            raise ValueError(f"{name} erwartet Text")
        if spec["type"] == "checkbox" and not isinstance(value, bool):
            raise ValueError(f"{name} erwartet Wahrheitswert")
        if isinstance(value, str) and len(value) > (spec["max_length"] or 10_000):
            raise ValueError(f"{name} ist zu lang")


def db_session() -> Session:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return Session(engine)


def seed(db: Session) -> tuple[Site, User]:
    site = Site(site_number="4711", name="Umbau Nord", customer="Beispiel GmbH")
    user = User(
        username="besteller",
        display_name="Bea Besteller",
        password_hash="x",
        role=UserRole.OFFICE,
        office_page_permissions=["sites"],
    )
    db.add_all([site, user])
    db.commit()
    return site, user


class FakeGraphStorage:
    def __init__(self, *, fail_upload: bool = False) -> None:
        self.graph_client = self
        self.fail_upload = fail_upload
        self.items: list[dict] = []
        self.contents: dict[str, bytes] = {}
        self.puts: list[str] = []
        self.list_calls = 0
        self.downloads: list[str] = []

    def add_existing(self, name: str, content: bytes | None = None) -> None:
        item_id = f"item-{len(self.items) + 1}"
        self.items.append(self._item(item_id, name, len(content or b"")))
        self.contents[item_id] = content or pdf_bytes()

    def list_folder_children(self, **_kwargs):
        self.list_calls += 1
        return [dict(item) for item in self.items]

    def download_file_from_folder(self, *, item_id: str, **_kwargs):
        self.downloads.append(item_id)
        return {
            "content": self.contents[item_id],
            "content_type": "application/pdf",
            "filename": next(item["name"] for item in self.items if item["id"] == item_id),
        }

    def put_content(self, path: str, content: bytes, content_type: str | None = None):
        self.puts.append(path)
        if self.fail_upload:
            raise MicrosoftGraphRequestError(503, "unavailable")
        encoded_name = path.split(":/", 1)[1].split(":/content", 1)[0]
        name = unquote(encoded_name)
        if any(item["name"].casefold() == name.casefold() for item in self.items):
            raise MicrosoftGraphRequestError(409, "conflict", error_code="nameAlreadyExists")
        item_id = f"item-{len(self.items) + 1}"
        item = self._item(item_id, name, len(content))
        self.items.append(item)
        self.contents[item_id] = content
        return {
            "id": item_id,
            "name": name,
            "webUrl": item["web_url"],
            "size": len(content),
            "file": {"mimeType": content_type},
        }

    @staticmethod
    def _item(item_id: str, name: str, size: int) -> dict:
        return {
            "id": item_id,
            "name": name,
            "web_url": f"https://example.invalid/{item_id}",
            "size": size,
            "mime_type": "application/pdf",
            "file_extension": "pdf",
            "is_folder": False,
        }


class ConcurrentWinnerStorage(FakeGraphStorage):
    def __init__(self) -> None:
        super().__init__()
        self.won_race = False

    def put_content(self, path: str, content: bytes, content_type: str | None = None):
        if not self.won_race:
            self.won_race = True
            self.puts.append(path)
            encoded_name = path.split(":/", 1)[1].split(":/content", 1)[0]
            name = unquote(encoded_name)
            self.add_existing(name, content)
            raise MicrosoftGraphRequestError(
                409,
                "concurrent winner",
                error_code="nameAlreadyExists",
            )
        return super().put_content(path, content, content_type)


class ExactNameLookupStorage(FakeGraphStorage):
    """Simulate a candidate absent from the first children page but addressable by path."""

    def list_folder_children(self, **_kwargs):
        self.list_calls += 1
        return []

    def get(self, path: str):
        encoded_name = path.split(":/", 1)[1].split("?$select", 1)[0]
        name = unquote(encoded_name)
        item = next(
            (item for item in self.items if item["name"].casefold() == name.casefold()),
            None,
        )
        if item is None:
            raise MicrosoftGraphRequestError(404, "not found")
        return {
            "id": item["id"],
            "name": item["name"],
            "webUrl": item["web_url"],
            "size": item["size"],
            "file": {"mimeType": "application/pdf"},
        }


def service(db: Session, storage=None) -> MaterialOrderService:
    return MaterialOrderService(
        db,
        storage_service=storage,
        form_provider=lambda: FORM,
        template_provider=pdf_bytes,
        pdf_builder=lambda _values: pdf_bytes(),
        values_validator=validate,
        now_provider=lambda: datetime(2026, 11, 16, 23, 30, tzinfo=UTC),
    )


def test_open_draft_is_resumable_per_site_and_user_with_prefill():
    db = db_session()
    site, user = seed(db)

    first = service(db).open_draft(site_id=site.id, current_user=user)
    second = service(db).open_draft(site_id=site.id, current_user=user)

    assert first.id == second.id
    assert first.revision == 0
    assert first.values == {
        "customer": "Beispiel GmbH",
        "project": "Umbau Nord",
        "commission": "4711",
        "requested_by": "Bea Besteller",
    }


def test_autosave_uses_optimistic_revision_and_validates_without_building_pdf():
    db = db_session()
    site, user = seed(db)
    build_calls = []
    order_service = service(db)
    order_service.pdf_builder = lambda values: build_calls.append(values) or pdf_bytes()
    draft = order_service.open_draft(site_id=site.id, current_user=user)

    saved = order_service.save_draft(
        site_id=site.id,
        draft_id=draft.id,
        current_user=user,
        payload=MaterialOrderValuesUpdate(revision=0, values={"material_1": "Kabelrinne"}),
    )
    assert saved.revision == 1
    assert build_calls == []

    with pytest.raises(HTTPException) as stale:
        order_service.save_draft(
            site_id=site.id,
            draft_id=draft.id,
            current_user=user,
            payload=MaterialOrderValuesUpdate(revision=0, values={"material_1": "Rohr"}),
        )
    assert stale.value.status_code == 409
    db.refresh(db.get(MaterialOrderDraft, draft.id))
    assert db.get(MaterialOrderDraft, draft.id).values == {"material_1": "Kabelrinne"}


def test_draft_cannot_be_read_or_changed_through_another_user_or_site():
    db = db_session()
    site, user = seed(db)
    other_site = Site(site_number="4712", name="Andere Baustelle")
    other_user = User(
        username="andere-person",
        display_name="Andere Person",
        password_hash="x",
        role=UserRole.OFFICE,
        office_page_permissions=["sites"],
    )
    db.add_all([other_site, other_user])
    db.commit()
    order_service = service(db)
    draft = order_service.open_draft(site_id=site.id, current_user=user)
    payload = MaterialOrderValuesUpdate(revision=0, values={"material_1": "Kabelrinne"})

    for scoped_site, scoped_user in ((site.id, other_user), (other_site.id, user)):
        with pytest.raises(HTTPException) as error:
            order_service.save_draft(
                site_id=scoped_site,
                draft_id=draft.id,
                current_user=scoped_user,
                payload=payload,
            )
        assert error.value.status_code == 404


def test_three_digit_collision_suffix_round_trips_to_the_same_base():
    filename = "261117_Lagerbestellung_100.pdf"

    assert _base_filename(filename) == "261117_Lagerbestellung.pdf"
    assert _filename_number(filename) == 100
    assert _numbered_filename(_base_filename(filename), 101) == (
        "261117_Lagerbestellung_101.pdf"
    )


def test_complete_rejects_empty_order_before_graph_or_reservation():
    db = db_session()
    site, user = seed(db)
    storage = FakeGraphStorage()
    order_service = service(db, storage)
    draft = order_service.open_draft(site_id=site.id, current_user=user)

    with pytest.raises(HTTPException) as error:
        order_service.complete(
            site_id=site.id,
            draft_id=draft.id,
            current_user=user,
            payload=MaterialOrderValuesUpdate(revision=0, values={"customer": "Kunde"}),
            drive_id="drive-1",
            folder_item_id="folder-1",
        )

    assert error.value.status_code == 422
    stored = db.get(MaterialOrderDraft, draft.id)
    assert stored.revision == 0
    assert stored.completion_token is None
    assert storage.puts == []


def test_local_pdf_build_failure_does_not_create_pending_reservation():
    db = db_session()
    site, user = seed(db)
    storage = FakeGraphStorage()
    order_service = service(db, storage)
    order_service.pdf_builder = lambda _values: (_ for _ in ()).throw(ValueError("kaputt"))
    draft = order_service.open_draft(site_id=site.id, current_user=user)

    with pytest.raises(HTTPException) as error:
        order_service.complete(
            site_id=site.id,
            draft_id=draft.id,
            current_user=user,
            payload=MaterialOrderValuesUpdate(
                revision=0,
                values={"material_1": "Kabelrinne"},
            ),
            drive_id="drive-1",
            folder_item_id="folder-1",
        )

    assert error.value.status_code == 422
    stored = db.get(MaterialOrderDraft, draft.id)
    assert stored.revision == 0
    assert stored.completion_pending is False
    assert storage.puts == []


def test_default_pdf_builder_embeds_recovery_metadata_without_second_pass(monkeypatch):
    db = db_session()
    site, user = seed(db)
    storage = FakeGraphStorage()
    order_service = MaterialOrderService(
        db,
        storage_service=storage,
        now_provider=lambda: datetime(2026, 11, 16, 23, 30, tzinfo=UTC),
    )
    draft = order_service.open_draft(site_id=site.id, current_user=user)

    def unexpected_metadata_pass(*_args, **_kwargs):
        raise AssertionError("default builder must write metadata in its only pass")

    monkeypatch.setattr(
        "app.services.material_order_service._add_completion_metadata",
        unexpected_metadata_pass,
    )
    completed = order_service.complete(
        site_id=site.id,
        draft_id=draft.id,
        current_user=user,
        payload=MaterialOrderValuesUpdate(
            revision=0,
            values={"material_1": "Kabelrinne"},
        ),
        drive_id="drive-1",
        folder_item_id="folder-1",
    )

    metadata = PdfReader(BytesIO(storage.contents[completed.document.id])).metadata
    assert metadata["/MaterialOrderDraftId"] == draft.id
    assert metadata["/MaterialOrderCompletionToken"]


def test_complete_uses_berlin_filename_collision_suffix_and_never_overwrites():
    db = db_session()
    site, user = seed(db)
    storage = FakeGraphStorage()
    storage.add_existing("261117_Lagerbestellung.pdf")
    order_service = service(db, storage)
    draft = order_service.open_draft(site_id=site.id, current_user=user)
    payload = MaterialOrderValuesUpdate(revision=0, values={"material_1": "Kabelrinne"})

    result = order_service.complete(
        site_id=site.id,
        draft_id=draft.id,
        current_user=user,
        payload=payload,
        drive_id="drive-1",
        folder_item_id="folder-1",
    )

    assert result.draft.filename == "261117_Lagerbestellung_02.pdf"
    assert [item["name"] for item in storage.items] == [
        "261117_Lagerbestellung.pdf",
        "261117_Lagerbestellung_02.pdf",
    ]
    assert storage.list_calls == 1
    assert storage.downloads == []
    assert "conflictBehavior=fail" in storage.puts[0]

    retry = order_service.complete(
        site_id=site.id,
        draft_id=draft.id,
        current_user=user,
        payload=payload,
        drive_id="drive-1",
        folder_item_id="folder-1",
    )
    assert retry.document.id == result.document.id
    assert len(storage.puts) == 1


@pytest.mark.parametrize("storage", [FakeGraphStorage(), ExactNameLookupStorage()])
def test_foreign_collision_uses_suffix_even_if_corrupt_or_absent_from_first_page(storage):
    db = db_session()
    site, user = seed(db)
    storage.add_existing("261117_Lagerbestellung.pdf", b"")
    order_service = service(db, storage)
    draft = order_service.open_draft(site_id=site.id, current_user=user)

    completed = order_service.complete(
        site_id=site.id,
        draft_id=draft.id,
        current_user=user,
        payload=MaterialOrderValuesUpdate(
            revision=0,
            values={"material_1": "Kabelrinne"},
        ),
        drive_id="drive-1",
        folder_item_id="folder-1",
    )

    assert completed.draft.filename == "261117_Lagerbestellung_02.pdf"
    assert [item["name"] for item in storage.items] == [
        "261117_Lagerbestellung.pdf",
        "261117_Lagerbestellung_02.pdf",
    ]
    if isinstance(storage, ExactNameLookupStorage):
        assert storage.downloads == ["item-1"]
    else:
        assert storage.downloads == []


def test_fresh_collision_reserves_hinted_suffix_before_upload_failure():
    db = db_session()
    site, user = seed(db)
    storage = FakeGraphStorage(fail_upload=True)
    storage.add_existing("261117_Lagerbestellung.pdf")
    order_service = service(db, storage)
    draft = order_service.open_draft(site_id=site.id, current_user=user)

    with pytest.raises(HTTPException) as error:
        order_service.complete(
            site_id=site.id,
            draft_id=draft.id,
            current_user=user,
            payload=MaterialOrderValuesUpdate(
                revision=0,
                values={"material_1": "Kabelrinne"},
            ),
            drive_id="drive-1",
            folder_item_id="folder-1",
        )

    assert error.value.status_code == 502
    stored = db.get(MaterialOrderDraft, draft.id)
    assert stored.completion_pending is True
    assert stored.completion_filename == "261117_Lagerbestellung_02.pdf"
    assert "261117_Lagerbestellung_02.pdf" in unquote(storage.puts[0])
    assert storage.downloads == []


def test_graph_failure_keeps_latest_draft_and_recovery_reservation():
    db = db_session()
    site, user = seed(db)
    storage = FakeGraphStorage(fail_upload=True)
    order_service = service(db, storage)
    draft = order_service.open_draft(site_id=site.id, current_user=user)
    payload = MaterialOrderValuesUpdate(revision=0, values={"material_1": "Kabelrinne"})

    with pytest.raises(HTTPException) as error:
        order_service.complete(
            site_id=site.id,
            draft_id=draft.id,
            current_user=user,
            payload=payload,
            drive_id="drive-1",
            folder_item_id="folder-1",
        )
    assert error.value.status_code == 502

    stored = db.get(MaterialOrderDraft, draft.id)
    assert stored.status == "draft"
    assert stored.values == {"material_1": "Kabelrinne"}
    assert stored.revision == 1
    assert stored.completion_token
    assert stored.completion_pending is True


def test_concurrent_same_draft_upload_recovers_winner_instead_of_creating_suffix():
    db = db_session()
    site, user = seed(db)
    storage = ConcurrentWinnerStorage()
    order_service = service(db, storage)
    draft = order_service.open_draft(site_id=site.id, current_user=user)
    payload = MaterialOrderValuesUpdate(revision=0, values={"material_1": "Kabelrinne"})

    completed = order_service.complete(
        site_id=site.id,
        draft_id=draft.id,
        current_user=user,
        payload=payload,
        drive_id="drive-1",
        folder_item_id="folder-1",
    )

    assert completed.draft.filename == "261117_Lagerbestellung.pdf"
    assert [item["name"] for item in storage.items] == ["261117_Lagerbestellung.pdf"]
    assert len(storage.puts) == 1
    assert storage.downloads == ["item-1"]


def test_retry_recovers_remote_upload_after_failure_before_final_db_commit(monkeypatch):
    db = db_session()
    site, user = seed(db)
    storage = FakeGraphStorage()
    order_service = service(db, storage)
    draft = order_service.open_draft(site_id=site.id, current_user=user)
    payload = MaterialOrderValuesUpdate(revision=0, values={"material_1": "Kabelrinne"})
    calls = 0

    def fail_once(_db, _site_id):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("simulated DB-side failure after Graph")

    monkeypatch.setattr(
        "app.services.material_order_service.invalidate_site_counts",
        fail_once,
    )
    with pytest.raises(RuntimeError):
        order_service.complete(
            site_id=site.id,
            draft_id=draft.id,
            current_user=user,
            payload=payload,
            drive_id="drive-1",
            folder_item_id="folder-1",
        )

    assert len(storage.puts) == 1
    stored = db.scalar(select(MaterialOrderDraft).where(MaterialOrderDraft.id == draft.id))
    assert stored.status == "draft"
    assert stored.completion_filename == "261117_Lagerbestellung.pdf"

    recovered = order_service.complete(
        site_id=site.id,
        draft_id=draft.id,
        current_user=user,
        payload=payload,
        drive_id="drive-1",
        folder_item_id="folder-1",
    )
    assert recovered.draft.status == "completed"
    assert recovered.draft.filename == "261117_Lagerbestellung.pdf"
    assert len(storage.items) == 1
    assert len(storage.puts) == 1
    assert storage.downloads == ["item-1"]
