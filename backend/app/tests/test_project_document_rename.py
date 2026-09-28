from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.api.dependencies import get_current_app_user
from app.api.routes import sites
from app.core.database import get_db
from app.models.enums import UserRole
from app.schemas.project_folder import ProjectDocumentRename
from app.services.microsoft_graph_client import MicrosoftGraphRequestError
from app.services.project_storage_service import ProjectStorageService
from app.tests.test_project_subfolder_create import FolderGraph
from app.tests.test_project_storage_service import enabled_config, graph_config


class RenameGraph(FolderGraph):
    def patch(self, path, payload):
        self.patches.append((path, payload))
        return {"id": path.rsplit("/", 1)[-1], "name": payload["name"], "file": {"mimeType": "application/pdf"}}


@pytest.mark.parametrize("item_id", ["file-1", "nested-file-1"])
def test_rename_keeps_identity_and_uses_conflict_fail(item_id):
    graph = RenameGraph()
    result = ProjectStorageService(config=enabled_config(), graph_client=graph).rename_file_from_folder(
        drive_id="drive-1", folder_item_id="folder-1", item_id=item_id, name="Neuer Plan.pdf",
    )
    assert result["id"] == item_id
    assert result["name"] == "Neuer Plan.pdf"
    assert not result["is_folder"]
    assert graph.patches == [(f"/drives/drive-1/items/{item_id}", {"name": "Neuer Plan.pdf", "@microsoft.graph.conflictBehavior": "fail"})]


@pytest.mark.parametrize("item_id", ["folder-2", "foreign-file-1"])
def test_rejects_folders_and_foreign_files(item_id):
    graph = RenameGraph()
    with pytest.raises(HTTPException):
        ProjectStorageService(config=enabled_config(), graph_client=graph).rename_file_from_folder(
            drive_id="drive-1", folder_item_id="folder-1", item_id=item_id, name="Plan.pdf",
        )
    assert graph.patches == []


@pytest.mark.parametrize("code,expected", [(409, 409), (403, 502), (404, 404)])
def test_errors_do_not_overwrite_or_leak_graph_details(code, expected):
    class FailedGraph(RenameGraph):
        def patch(self, path, payload):
            raise MicrosoftGraphRequestError(code, "private diagnostics")
    with pytest.raises(HTTPException) as error:
        ProjectStorageService(config=enabled_config(), graph_client=FailedGraph()).rename_file_from_folder(
            drive_id="drive-1", folder_item_id="folder-1", item_id="file-1", name="Plan.pdf",
        )
    assert error.value.status_code == expected
    assert "private diagnostics" not in error.value.detail


@pytest.mark.parametrize("name", ["", " ", ".", "..", "a/b.pdf", "a\\b.pdf", "a?.pdf", "a:.pdf", "Plan.", "a\nb.pdf", "a" * 256])
def test_invalid_names_are_rejected(name):
    with pytest.raises(ValidationError):
        ProjectDocumentRename(name=name)


def test_valid_names_and_local_isolation():
    assert ProjectDocumentRename(name="  Übersicht 2026.pdf  ").name == "Übersicht 2026.pdf"
    graph = RenameGraph()
    with pytest.raises(HTTPException):
        ProjectStorageService(config=graph_config(), graph_client=graph).rename_file_from_folder(
            drive_id="drive-1", folder_item_id="folder-1", item_id="file-1", name="Plan.pdf",
        )
    assert graph.patches == []


@pytest.mark.parametrize("role,permissions,expected", [
    (UserRole.ADMIN, [], 200), (UserRole.PROJECT_MANAGER, [], 200),
    (UserRole.OFFICE, ["sites"], 200), (UserRole.OFFICE, ["calendar"], 403), (UserRole.MONTEUR, [], 403),
])
def test_route_permissions_and_scoped_rename(monkeypatch, role, permissions, expected):
    graph = RenameGraph()
    storage = ProjectStorageService(config=enabled_config(), graph_client=graph)
    class Folders:
        def __init__(self, db): pass
        def get_project_folder_for_site_by_key(self, site_id, folder_key, user):
            assert (site_id, folder_key) == (7, "aufmass")
            return SimpleNamespace(external_drive_id="drive-1", external_item_id="folder-1")
    monkeypatch.setattr(sites, "ProjectFolderService", Folders)
    monkeypatch.setattr(sites, "ProjectStorageService", lambda: storage)
    app = FastAPI()
    app.include_router(sites.router)
    app.dependency_overrides[get_db] = lambda: object()
    app.dependency_overrides[get_current_app_user] = lambda: SimpleNamespace(role=role, office_page_permissions=permissions)
    response = TestClient(app).patch("/sites/7/documents/folders/aufmass/items/nested-file-1/name", json={"name": " Neu.pdf "})
    assert response.status_code == expected
    if expected == 200:
        assert response.json()["name"] == "Neu.pdf"
    else:
        assert graph.patches == []
