from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.api.dependencies import get_current_app_user
from app.api.routes import sites
from app.core.database import get_db
from app.models.enums import UserRole
from app.services.microsoft_graph_client import MicrosoftGraphRequestError
from app.services.project_storage_service import ProjectStorageService
from app.tests.test_project_subfolder_create import FolderGraph
from app.tests.test_project_storage_service import enabled_config, graph_config


class MoveGraph(FolderGraph):
    def patch(self, path, payload):
        self.patches.append((path, payload))
        return {"id": path.rsplit("/", 1)[-1], "name": "Plan.pdf", "file": {"mimeType": "application/pdf"}}


def move(graph, **overrides):
    arguments = dict(drive_id="drive-1", folder_item_id="folder-1", item_id="file-1",
                     target_drive_id="drive-1", target_folder_item_id="folder-1", target_parent_item_id="folder-2")
    arguments.update(overrides)
    return ProjectStorageService(config=enabled_config(), graph_client=graph).move_file_from_folder(**arguments)


@pytest.mark.parametrize("parent", [None, "folder-2"])
def test_move_keeps_file_identity_and_never_overwrites(parent):
    graph = MoveGraph()
    result = move(graph, item_id="nested-file-1", target_parent_item_id=parent)
    assert result["id"] == "nested-file-1"
    assert graph.patches == [("/drives/drive-1/items/nested-file-1", {
        "parentReference": {"id": parent or "folder-1"}, "@microsoft.graph.conflictBehavior": "fail",
    })]


def test_move_between_authorized_standard_roots():
    graph = MoveGraph()
    move(graph, target_folder_item_id="foreign-folder-1", target_parent_item_id=None)
    assert graph.patches[0][1]["parentReference"]["id"] == "foreign-folder-1"


@pytest.mark.parametrize("override", [
    {"item_id": "foreign-file-1"}, {"item_id": "folder-2"}, {"item_id": "folder-1"},
    {"target_parent_item_id": "foreign-folder-1"}, {"target_parent_item_id": "file-1"},
    {"target_drive_id": "other-drive"}, {"target_drive_id": None}, {"target_folder_item_id": None},
])
def test_invalid_sources_targets_and_cross_drive_moves_do_not_mutate(override):
    graph = MoveGraph()
    with pytest.raises(HTTPException):
        move(graph, **override)
    assert graph.patches == []


@pytest.mark.parametrize("code,expected", [(409, 409), (403, 502), (404, 404), (None, 502)])
def test_move_errors_remain_safe(code, expected):
    class FailedGraph(MoveGraph):
        def patch(self, path, payload):
            raise MicrosoftGraphRequestError(code, "private graph details")
    with pytest.raises(HTTPException) as error:
        move(FailedGraph())
    assert error.value.status_code == expected
    assert "private graph details" not in error.value.detail


def test_local_test_cannot_mutate_cloud():
    graph = MoveGraph()
    with pytest.raises(HTTPException):
        ProjectStorageService(config=graph_config(), graph_client=graph).move_file_from_folder(
            drive_id="drive-1", folder_item_id="folder-1", item_id="file-1",
            target_drive_id="drive-1", target_folder_item_id="folder-1", target_parent_item_id="folder-2",
        )
    assert graph.patches == []


@pytest.mark.parametrize("role,permissions,expected", [
    (UserRole.ADMIN, [], 200), (UserRole.PROJECT_MANAGER, [], 200),
    (UserRole.OFFICE, ["sites"], 200), (UserRole.OFFICE, ["calendar"], 403), (UserRole.MONTEUR, [], 403),
])
def test_route_authorizes_both_folders_and_invalidates_counts(monkeypatch, role, permissions, expected):
    graph = MoveGraph()
    checked = []
    commits = []
    invalidations = []
    class Folders:
        def __init__(self, db): pass
        def get_project_folder_for_site_by_key(self, site_id, folder_key, user):
            checked.append((site_id, folder_key))
            return SimpleNamespace(external_drive_id="drive-1", external_item_id="folder-1")
    monkeypatch.setattr(sites, "ProjectFolderService", Folders)
    monkeypatch.setattr(sites, "ProjectStorageService", lambda: ProjectStorageService(config=enabled_config(), graph_client=graph))
    monkeypatch.setattr(sites, "invalidate_site_counts", lambda db, site: invalidations.append(site))
    app = FastAPI()
    app.include_router(sites.router)
    app.dependency_overrides[get_db] = lambda: SimpleNamespace(commit=lambda: commits.append(True))
    app.dependency_overrides[get_current_app_user] = lambda: SimpleNamespace(role=role, office_page_permissions=permissions)
    response = TestClient(app).patch("/sites/7/documents/folders/aufmass/items/file-1/move", json={
        "target_folder_key": "dokumentation", "target_parent_item_id": "folder-2",
    })
    assert response.status_code == expected
    if expected == 200:
        assert checked == [(7, "aufmass"), (7, "dokumentation")]
        assert invalidations == [7] and commits == [True]
        assert len(graph.patches) == 1
    else:
        assert not checked and not graph.patches and not invalidations and not commits
