import asyncio
from datetime import datetime
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.api.routes import sites
from app.models.enums import UserRole
from app.services.photo_filename import PHOTO_FILENAME_TIMEZONE


class FakeUploadFile:
    filename = "image.jpg"
    content_type = "image/jpeg"

    async def read(self):
        return b"image-content"


def _install_document_content_fakes(monkeypatch, download):
    calls = {"folder": [], "download": [], "children": []}

    class FakeProjectFolderService:
        def __init__(self, db):
            self.db = db

        def get_project_folder_for_site_by_key(self, site_id, folder_key, current_user):
            calls["folder"].append((site_id, folder_key, current_user.role))
            return SimpleNamespace(
                external_drive_id="drive-1",
                external_item_id="folder-1",
                folder_key=folder_key,
                name=folder_key,
            )

    class FakeProjectStorageService:
        def download_file_from_folder(self, *, drive_id, folder_item_id, item_id):
            calls["download"].append((drive_id, folder_item_id, item_id))
            return download

        def list_folder_item_children(self, *, drive_id, root_folder_item_id, item_id):
            calls["children"].append((drive_id, root_folder_item_id, item_id))
            return [
                {
                    "id": "nested-file-1",
                    "name": "Zeichnung.png",
                    "web_url": None,
                    "size": 123,
                    "last_modified_date_time": "2026-06-05T08:00:00Z",
                    "mime_type": "image/png",
                    "file_extension": "png",
                    "is_folder": False,
                }
            ]

    monkeypatch.setattr(sites, "ProjectFolderService", FakeProjectFolderService)
    monkeypatch.setattr(sites, "ProjectStorageService", FakeProjectStorageService)
    return calls


def test_project_folder_document_content_serves_safe_pdf_inline(monkeypatch):
    calls = _install_document_content_fakes(
        monkeypatch,
        {
            "content": b"pdf-bytes",
            "content_type": "application/pdf",
            "filename": "Angebot & Zeichnung.pdf",
        },
    )

    response = sites.get_project_folder_document_content(
        site_id=7,
        folder_key="angebote",
        item_id="file-1",
        disposition="inline",
        current_user=SimpleNamespace(role=UserRole.MONTEUR),
        db=object(),
    )

    assert response.body == b"pdf-bytes"
    assert response.headers["content-type"] == "application/pdf"
    assert response.headers["content-disposition"] == (
        "inline; filename*=UTF-8''Angebot%20%26%20Zeichnung.pdf"
    )
    assert calls["folder"] == [(7, "angebote", UserRole.MONTEUR)]
    assert calls["download"] == [("drive-1", "folder-1", "file-1")]


def test_project_folder_item_children_uses_folder_access_and_storage_validation(monkeypatch):
    calls = _install_document_content_fakes(monkeypatch, {})

    response = sites.list_project_folder_item_children(
        site_id=7,
        folder_key="zeichnungen",
        item_id="subfolder-1",
        current_user=SimpleNamespace(role=UserRole.MONTEUR),
        db=object(),
    )

    assert response.folder_key == "zeichnungen"
    assert response.folder_name == "zeichnungen"
    assert response.items[0].id == "nested-file-1"
    assert calls["folder"] == [(7, "zeichnungen", UserRole.MONTEUR)]
    assert calls["children"] == [("drive-1", "folder-1", "subfolder-1")]


def test_project_folder_document_content_forces_unsafe_inline_to_attachment(monkeypatch):
    _install_document_content_fakes(
        monkeypatch,
        {
            "content": b"binary",
            "content_type": "application/vnd.ms-excel",
            "filename": "Liste.xls",
        },
    )

    response = sites.get_project_folder_document_content(
        site_id=7,
        folder_key="angebote",
        item_id="file-1",
        disposition="inline",
        current_user=SimpleNamespace(role=UserRole.ADMIN),
        db=object(),
    )

    assert response.body == b"binary"
    assert response.headers["content-type"] == "application/octet-stream"
    assert response.headers["content-disposition"] == (
        "attachment; filename*=UTF-8''Liste.xls"
    )


def test_project_folder_document_content_rejects_invalid_disposition():
    with pytest.raises(HTTPException) as error:
        sites.get_project_folder_document_content(
            site_id=7,
            folder_key="angebote",
            item_id="file-1",
            disposition="preview",
            current_user=SimpleNamespace(role=UserRole.ADMIN),
            db=object(),
        )

    assert error.value.status_code == 400


def test_project_folder_photo_upload_uses_clean_site_photo_filename(monkeypatch):
    calls = {"upload": []}
    date_prefix = datetime.now(PHOTO_FILENAME_TIMEZONE).strftime("%y%m%d")

    class FakeProjectFolderService:
        def __init__(self, db):
            self.db = db

        def get_project_folder_for_site_by_key(self, site_id, folder_key, current_user):
            assert (site_id, folder_key, current_user.role) == (7, "fotos", UserRole.MONTEUR)
            return SimpleNamespace(
                external_drive_id="drive-1",
                external_item_id="folder-1",
                folder_key=folder_key,
                name=folder_key,
            )

    class FakeProjectStorageService:
        def list_folder_children(self, *, drive_id, folder_item_id):
            assert (drive_id, folder_item_id) == ("drive-1", "folder-1")
            return [
                {
                    "name": f"{date_prefix}_Schüchtermann_Klinik_Christopher_Erichsen.jpg",
                }
            ]

        def upload_file_to_folder(self, *, drive_id, folder_item_id, filename, content, content_type):
            calls["upload"].append((drive_id, folder_item_id, filename, content, content_type))
            return {
                "id": "uploaded-photo",
                "name": filename,
                "web_url": None,
                "size": len(content),
                "last_modified_date_time": "2026-06-13T08:00:00Z",
                "mime_type": content_type,
                "file_extension": "jpg",
                "is_folder": False,
            }

    class FakeSiteService:
        def __init__(self, db):
            self.db = db

        def get_site(self, site_id):
            assert site_id == 7
            return SimpleNamespace(name='Schüchtermann / Klinik')

    user = SimpleNamespace(
        id=3,
        role=UserRole.MONTEUR,
        display_name="Christopher Erichsen",
        username="christopher",
        person=SimpleNamespace(display_name="Christopher Erichsen"),
    )
    monkeypatch.setattr(sites, "ProjectFolderService", FakeProjectFolderService)
    monkeypatch.setattr(sites, "ProjectStorageService", FakeProjectStorageService)
    monkeypatch.setattr(sites, "SiteService", FakeSiteService)

    response = asyncio.run(
        sites.upload_project_folder_document(
            site_id=7,
            folder_key="fotos",
            file=FakeUploadFile(),
            current_user=user,
            db=object(),
        )
    )

    assert response.name == f"{date_prefix}_Schüchtermann_Klinik_Christopher_Erichsen_02.jpg"
    assert calls["upload"] == [
        (
            "drive-1",
            "folder-1",
            f"{date_prefix}_Schüchtermann_Klinik_Christopher_Erichsen_02.jpg",
            b"image-content",
            "image/jpeg",
        )
    ]
