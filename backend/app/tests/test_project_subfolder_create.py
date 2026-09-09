from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.api.dependencies import get_current_app_user
from app.api.routes import sites
from app.core.database import get_db
from app.models.enums import UserRole
from app.schemas.project_folder import ProjectSubfolderCreate
from app.services.microsoft_graph_client import MicrosoftGraphRequestError
from app.services.project_storage_service import ProjectStorageService
from app.tests.test_project_storage_service import FakeGraphClient, enabled_config, graph_config


class FolderGraph(FakeGraphClient):
    def get(self, path):
        if path.startswith("/drives/drive-1/items/folder-1?"):
            return {"id": "folder-1", "name": "Dokumentation", "folder": {}}
        return super().get(path)

    def post(self, path, payload):
        self.posts.append((path, payload))
        return {"id": "created", "name": payload["name"], "folder": {}}


@pytest.mark.parametrize("parent,expected", [(None, "folder-1"), ("folder-2", "folder-2")])
def test_create_in_root_or_verified_descendant(parent, expected):
    graph = FolderGraph()
    result = ProjectStorageService(config=enabled_config(), graph_client=graph).create_subfolder(
        drive_id="drive-1", root_folder_item_id="folder-1", parent_item_id=parent, name="Pläne 2026",
    )
    assert result["is_folder"] is True
    assert graph.posts == [(f"/drives/drive-1/items/{expected}/children", {
        "name": "Pläne 2026", "folder": {}, "@microsoft.graph.conflictBehavior": "fail",
    })]


@pytest.mark.parametrize("parent,code", [("foreign-folder-1", 404), ("file-1", 400)])
def test_rejects_foreign_parent_and_files(parent, code):
    graph = FolderGraph()
    with pytest.raises(HTTPException) as error:
        ProjectStorageService(config=enabled_config(), graph_client=graph).create_subfolder(
            drive_id="drive-1", root_folder_item_id="folder-1", parent_item_id=parent, name="Test",
        )
    assert error.value.status_code == code
    assert graph.posts == []


@pytest.mark.parametrize("code,expected", [(409, 409), (403, 502), (None, 502)])
def test_storage_errors_are_reported_without_overwriting(code, expected):
    class FailedGraph(FolderGraph):
        def post(self, path, payload):
            raise MicrosoftGraphRequestError(code, "private diagnostics")
    with pytest.raises(HTTPException) as error:
        ProjectStorageService(config=enabled_config(), graph_client=FailedGraph()).create_subfolder(
            drive_id="drive-1", root_folder_item_id="folder-1", parent_item_id=None, name="Test",
        )
    assert error.value.status_code == expected
    assert "private diagnostics" not in error.value.detail


@pytest.mark.parametrize("name", ["", "  ", ".", "..", "Plan.", "a/b", "a\\b", "a:b", 'a"b', "a*b", "a?b", "a<b", "a>b", "a|b", "a\nb", "a" * 256])
def test_invalid_folder_names(name):
    with pytest.raises(ValidationError):
        ProjectSubfolderCreate(name=name)


def test_name_is_trimmed_without_changing_umlauts():
    assert ProjectSubfolderCreate(name="  Pläne 2026  ").name == "Pläne 2026"


def test_local_isolation_prevents_creation():
    graph = FolderGraph()
    with pytest.raises(HTTPException):
        ProjectStorageService(config=graph_config(), graph_client=graph).create_subfolder(
            drive_id="drive-1", root_folder_item_id="folder-1", parent_item_id=None, name="Test",
        )
    assert graph.posts == []


@pytest.mark.parametrize("role,permissions,expected", [
    (UserRole.ADMIN, [], 201), (UserRole.PROJECT_MANAGER, [], 201),
    (UserRole.OFFICE, ["sites"], 201), (UserRole.OFFICE, ["calendar"], 403),
    (UserRole.MONTEUR, ["sites"], 403),
])
def test_route_enforces_edit_permissions_and_passes_scoped_parent(monkeypatch, role, permissions, expected):
    calls = []
    class Folders:
        def __init__(self, db):
            pass
        def get_project_folder_for_site_by_key(self, site_id, folder_key, user):
            calls.append((site_id, folder_key, user.role))
            return SimpleNamespace(external_drive_id="drive-1", external_item_id="folder-1")
    class Storage:
        def create_subfolder(self, **kwargs):
            calls.append(kwargs)
            return {"id": "created", "name": kwargs["name"], "is_folder": True}
    monkeypatch.setattr(sites, "ProjectFolderService", Folders)
    monkeypatch.setattr(sites, "ProjectStorageService", Storage)
    app = FastAPI()
    app.include_router(sites.router)
    app.dependency_overrides[get_db] = lambda: object()
    app.dependency_overrides[get_current_app_user] = lambda: SimpleNamespace(role=role, office_page_permissions=permissions)
    response = TestClient(app).post("/sites/7/documents/folders/dokumentation/subfolders", json={"name": " Pläne ", "parent_item_id": "folder-2"})
    assert response.status_code == expected
    if expected == 201:
        assert response.json()["is_folder"] is True
        assert calls == [(7, "dokumentation", role), {"drive_id": "drive-1", "root_folder_item_id": "folder-1", "parent_item_id": "folder-2", "name": "Pläne"}]
    else:
        assert calls == []
