from datetime import datetime, timezone
from io import BytesIO
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from PIL import Image

from app.api.dependencies import get_current_user
from app.api.routes import sites
from app.core.database import get_db
from app.models.enums import UserRole
from app.models.site_measurement_item import SiteMeasurementBatch, SiteMeasurementBatchPhoto
from app.models.user import User
from app.services.project_folder_service import ProjectFolderService
from app.services.measurement_service import MeasurementService
from app.services.project_storage_service import ProjectStorageService
from app.tests.test_measurement_service import create_site, db_session


def test_office_photos_are_scoped_to_site_batch_and_archive_before_storage_access(monkeypatch):
    db = db_session()
    site = create_site(db)
    other_site = create_site(db)
    batch = SiteMeasurementBatch(site=site, number=1, title="Aufmaß 1", status="reviewed")
    other = SiteMeasurementBatch(site=site, number=2, title="Aufmaß 2", status="reviewed")
    photo = SiteMeasurementBatchPhoto(site=site, measurement_batch=batch, external_drive_id="drive", external_item_id="item", filename="Montage.jpg", content_type="image/jpeg", caption="1. OG BTB")
    db.add_all([batch, other, photo])
    db.commit()
    calls = []
    monkeypatch.setattr(MeasurementService, "_get_photo_folder_item_id", lambda *args: "folder")
    def download(_self, **kwargs):
        calls.append(kwargs)
        return {"content": b"original", "content_type": "image/jpeg", "filename": "Montage.jpg"}
    monkeypatch.setattr(ProjectStorageService, "download_file_from_folder", download)
    service = MeasurementService(db)
    assert service.list_site_batch_photos(site_id=site.id, batch_id=batch.id)[0].caption == "1. OG BTB"
    assert service.list_site_batch_photos(site_id=site.id, batch_id=other.id) == []
    for wrong_site, wrong_batch in [(other_site.id, batch.id), (site.id, other.id)]:
        with pytest.raises(HTTPException) as error:
            service.get_site_batch_photo_content(site_id=wrong_site, batch_id=wrong_batch, photo_id=photo.id, current_user=None)
        assert error.value.status_code == 404
    assert calls == []
    assert service.get_site_batch_photo_content(site_id=site.id, batch_id=batch.id, photo_id=photo.id, current_user=None)[0] == b"original"
    batch.deleted_at = datetime.now(timezone.utc)
    db.commit()
    with pytest.raises(HTTPException):
        service.list_site_batch_photos(site_id=site.id, batch_id=batch.id)
    assert len(service.list_site_batch_photos(site_id=site.id, batch_id=batch.id, include_deleted=True)) == 1
    with pytest.raises(HTTPException):
        service.get_site_batch_photo_content(site_id=site.id, batch_id=batch.id, photo_id=photo.id, current_user=None)
    assert service.get_site_batch_photo_content(site_id=site.id, batch_id=batch.id, photo_id=photo.id, current_user=None, include_deleted=True)[0] == b"original"
    assert len(calls) == 2


@pytest.mark.parametrize("suffix", ["", "/1/content", "/1/thumbnail"])
@pytest.mark.parametrize("role,permissions", [(UserRole.MONTEUR, []), (UserRole.OFFICE, ["overview"])])
def test_office_photo_endpoints_require_existing_site_read_permission(suffix, role, permissions):
    app = FastAPI()
    app.include_router(sites.router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: None
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=1, role=role, is_active=True, must_change_password=False, office_page_permissions=permissions)
    response = TestClient(app).get(f"/api/sites/1/measurement-batches/1/photos{suffix}")
    assert response.status_code == 403


def test_photo_routes_return_metadata_original_and_shared_renderer_thumbnail(monkeypatch):
    app = FastAPI()
    app.include_router(sites.router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: None
    app.dependency_overrides[sites.CAN_READ] = lambda: SimpleNamespace(id=1)
    buffer = BytesIO()
    Image.new("RGB", (640, 480), "blue").save(buffer, format="JPEG")
    content = buffer.getvalue()
    monkeypatch.setattr(MeasurementService, "list_site_batch_photos", lambda *args, **kwargs: [])
    monkeypatch.setattr(MeasurementService, "get_site_batch_photo_content", lambda *args, **kwargs: (content, "image/jpeg", "Foto.jpg"))
    client = TestClient(app)
    base = "/api/sites/1/measurement-batches/1/photos"
    assert client.get(base).json() == []
    assert client.get(base + "/1/content").content == content
    response = client.get(base + "/1/thumbnail")
    assert response.status_code == 200
    assert max(Image.open(BytesIO(response.content)).size) <= 320
    assert response.headers["cache-control"].startswith("private")


@pytest.mark.parametrize("role,permissions", [(UserRole.MONTEUR, []), (UserRole.OFFICE, ["overview"]), (UserRole.OFFICE, ["calendar"])])
def test_office_photo_upload_requires_site_write_permission(role, permissions):
    app = FastAPI()
    app.include_router(sites.router, prefix="/api")
    app.dependency_overrides[get_db] = lambda: None
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=1, role=role, is_active=True, must_change_password=False, office_page_permissions=permissions)
    response = TestClient(app).post("/api/sites/1/measurement-batches/1/photos", files={"file": ("Foto.png", b"image", "image/png")})
    assert response.status_code == 403


def test_office_photo_upload_persists_scoped_optimized_photos_and_rejects_invalid_targets(monkeypatch):
    db = db_session()
    site, other_site = create_site(db), create_site(db)
    user = User(username="office", display_name="Büro", password_hash="x", role=UserRole.OFFICE)
    batch = SiteMeasurementBatch(site=site, number=1, title="Aufmaß 1", status="reviewed")
    archived = SiteMeasurementBatch(site=site, number=2, title="Archiv", status="reviewed", deleted_at=datetime.now(timezone.utc))
    db.add_all([user, batch, archived])
    db.commit()
    folder_calls, uploads = [], []
    def folder(_self, site_id, folder_key, current_user):
        folder_calls.append((site_id, current_user.id))
        return SimpleNamespace(external_drive_id="drive", external_item_id="folder")
    def upload(_self, **kwargs):
        uploads.append(kwargs)
        return {"id": f"item-{len(uploads)}", "name": kwargs["filename"]}
    monkeypatch.setattr(ProjectFolderService, "get_project_folder_for_site_by_key", folder)
    monkeypatch.setattr(ProjectStorageService, "upload_file_to_folder", upload)
    buffer = BytesIO()
    Image.new("RGB", (640, 480), "blue").save(buffer, format="PNG")
    service = MeasurementService(db)
    args = dict(current_user=user, filename="Foto.png", content=buffer.getvalue(), content_type="image/png")
    for site_id, batch_id in [(other_site.id, batch.id), (site.id, archived.id)]:
        with pytest.raises(HTTPException) as error:
            service.upload_site_batch_photo(site_id=site_id, batch_id=batch_id, **args)
        assert error.value.status_code == 404
    with pytest.raises(HTTPException) as error:
        service.upload_site_batch_photo(site_id=site.id, batch_id=batch.id, **{**args, "content_type": "application/pdf"})
    assert error.value.status_code == 400
    with pytest.raises(HTTPException):
        service.upload_site_batch_photo(site_id=site.id, batch_id=batch.id, **{**args, "content": b"invalid image"})
    assert uploads == folder_calls == []
    for _ in range(5):
        photo = service.upload_site_batch_photo(site_id=site.id, batch_id=batch.id, **args)
        assert photo.measurement_batch_id == batch.id
        assert photo.site_id == site.id
        assert photo.uploaded_by_name == "Büro"
    with pytest.raises(HTTPException) as error:
        service.upload_site_batch_photo(site_id=site.id, batch_id=batch.id, **args)
    assert error.value.status_code == 400
    assert len(uploads) == 5
    assert folder_calls == [(site.id, user.id)] * 5
    assert len(service.list_site_batch_photos(site_id=site.id, batch_id=batch.id)) == 5
    assert len({entry["filename"] for entry in uploads}) == 5
    assert all(entry["content_type"] == "image/jpeg" for entry in uploads)
    assert batch.status == "reviewed"


def test_office_upload_route_passes_multipart_to_shared_measurement_storage(monkeypatch):
    app = FastAPI()
    app.include_router(sites.router, prefix="/api")
    user = SimpleNamespace(id=1)
    app.dependency_overrides[get_db] = lambda: None
    app.dependency_overrides[sites.CAN_SITES_WRITE] = lambda: user
    calls = []
    def upload(_self, **kwargs):
        calls.append(kwargs)
        return dict(id=3, site_id=7, measurement_batch_id=8, filename="Foto.jpg", content_type="image/jpeg", file_size_bytes=5, external_web_url=None, taken_at=None, created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc))
    monkeypatch.setattr(MeasurementService, "upload_site_batch_photo", upload)
    response = TestClient(app).post("/api/sites/7/measurement-batches/8/photos", files={"file": ("Foto.png", b"image", "image/png")})
    assert response.status_code == 201
    assert response.json()["measurement_batch_id"] == 8
    assert calls == [dict(site_id=7, batch_id=8, current_user=user, filename="Foto.png", content=b"image", content_type="image/png")]
