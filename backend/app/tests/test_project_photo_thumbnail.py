from io import BytesIO
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from PIL import Image

from app.api.routes import sites
from app.services.document_thumbnail_service import DocumentThumbnailService


def photo():
    output = BytesIO()
    Image.new("RGB", (1600, 900), "#7194a6").save(output, "PNG")
    return output.getvalue()


def test_photo_thumbnail_is_small_jpeg_and_reuses_cache(tmp_path):
    service = DocumentThumbnailService(tmp_path)
    original = photo()
    path = service.get_or_create_photo_thumbnail(original, "test")
    with Image.open(path) as image:
        assert image.size == (320, 320)
        assert image.format == "JPEG"
    assert path.stat().st_size < len(original)
    assert service.get_or_create_photo_thumbnail(b"not decoded on cache hit", "test") == path
    assert list(tmp_path.glob("*.tmp")) == []


def test_invalid_photo_does_not_create_cache(tmp_path):
    service = DocumentThumbnailService(tmp_path)
    with pytest.raises(HTTPException):
        service.get_or_create_photo_thumbnail(b"invalid", "test")
    assert service.get_cached_thumbnail("test") is None


def test_photo_route_checks_access_and_descendants_before_cache_and_download(monkeypatch, tmp_path):
    calls = []
    folder = SimpleNamespace(folder_key="fotos", external_drive_id="drive", external_item_id="root")
    document = {"name": "Photo.JPG", "mime_type": "image/jpeg", "size": 100, "last_modified_date_time": "v1"}

    class Folders:
        def __init__(self, db):
            pass

        def get_project_folder_for_site_by_key(self, site, key, user):
            calls.append("authorize")
            return folder

    class Storage:
        def get_file_item_from_folder(self, **kwargs):
            assert kwargs["folder_item_id"] == "root"
            calls.append("descendant")
            return document

        def download_file_from_folder(self, **kwargs):
            calls.append("download")
            return {"content": photo()}

    monkeypatch.setattr(sites, "ProjectFolderService", Folders)
    monkeypatch.setattr(sites, "ProjectStorageService", Storage)
    monkeypatch.setattr(sites, "DocumentThumbnailService", lambda: DocumentThumbnailService(tmp_path))
    first = sites.get_project_folder_document_thumbnail(1, "fotos", "image", object(), None)
    assert first.media_type == "image/jpeg"
    assert calls == ["authorize", "descendant", "download"]
    calls.clear()
    second = sites.get_project_folder_document_thumbnail(1, "fotos", "image", object(), None)
    assert second.path == first.path
    assert calls == ["authorize", "descendant"]
    document["last_modified_date_time"] = "v2"
    third = sites.get_project_folder_document_thumbnail(1, "fotos", "image", object(), None)
    assert third.path != first.path
    assert calls[-1] == "download"
