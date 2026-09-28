from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.api.dependencies import get_current_app_user
from app.api.routes import sites
from app.core.database import get_db
from app.models.enums import UserRole
from app.services.project_storage_service import ProjectStorageService
from app.tests.test_project_subfolder_create import FolderGraph
from app.tests.test_project_storage_service import enabled_config, graph_config


@pytest.mark.parametrize("parent,expected_status", [
    (None, 200), ("folder-1", 200), ("folder-2", 200),
    ("foreign-folder-1", 404), ("file-1", 400),
])
def test_upload_route_scopes_target_before_writing(monkeypatch, parent, expected_status):
    graph = FolderGraph()
    storage = ProjectStorageService(config=enabled_config(), graph_client=graph)
    invalidated = []
    commits = []

    class Folders:
        def __init__(self, db):
            pass

        def get_project_folder_for_site_by_key(self, site_id, folder_key, user):
            assert (site_id, folder_key, user.role) == (7, "aufmass", UserRole.ADMIN)
            return SimpleNamespace(external_drive_id="drive-1", external_item_id="folder-1")

    monkeypatch.setattr(sites, "ProjectFolderService", Folders)
    monkeypatch.setattr(sites, "ProjectStorageService", lambda: storage)
    monkeypatch.setattr(sites, "invalidate_site_counts", lambda db, site_id: invalidated.append(site_id))
    app = FastAPI()
    app.include_router(sites.router)
    app.dependency_overrides[get_db] = lambda: SimpleNamespace(commit=lambda: commits.append(True))
    app.dependency_overrides[get_current_app_user] = lambda: SimpleNamespace(role=UserRole.ADMIN)
    response = TestClient(app).post(
        "/sites/7/documents/folders/aufmass/upload",
        data={"parent_item_id": parent} if parent else {},
        files={"file": ("Test.pdf", b"test-content", "application/pdf")},
    )
    assert response.status_code == expected_status
    if expected_status == 200:
        assert graph.puts == [(f"/drives/drive-1/items/{parent or 'folder-1'}:/Test.pdf:/content", b"test-content", "application/pdf")]
        assert invalidated == [7]
        assert commits == [True]
    else:
        assert graph.puts == invalidated == commits == []


def test_nested_folder_resolves_through_multiple_ancestors():
    class NestedGraph(FolderGraph):
        def get(self, path):
            if path.startswith("/drives/drive-1/items/deep-folder?"):
                return {"id": "deep-folder", "folder": {}, "parentReference": {"id": "folder-2"}}
            return super().get(path)
    storage = ProjectStorageService(config=enabled_config(), graph_client=NestedGraph())
    assert storage.resolve_upload_folder(drive_id="drive-1", root_folder_item_id="folder-1", parent_item_id="deep-folder") == "deep-folder"


def test_local_isolation_still_blocks_subfolder_uploads():
    graph = FolderGraph()
    with pytest.raises(HTTPException):
        ProjectStorageService(config=graph_config(), graph_client=graph).resolve_upload_folder(
            drive_id="drive-1", root_folder_item_id="folder-1", parent_item_id="folder-2",
        )
    assert graph.puts == []
