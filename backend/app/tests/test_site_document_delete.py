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
from app.tests.test_project_storage_service import FakeGraphClient, enabled_config, graph_config


@pytest.mark.parametrize("role,permissions,expected", [
    (UserRole.ADMIN, [], 204),
    (UserRole.PROJECT_MANAGER, [], 204),
    (UserRole.OFFICE, ["sites"], 204),
    (UserRole.OFFICE, ["calendar"], 403),
    (UserRole.MONTEUR, ["sites"], 403),
])
def test_delete_route_requires_site_edit_permission(monkeypatch, role, permissions, expected):
    calls = []

    class Folders:
        def __init__(self, db):
            pass

        def get_project_folder_for_site_by_key(self, site_id, folder_key, user):
            calls.append((site_id, folder_key, user.role))
            return SimpleNamespace(external_drive_id="drive-1", external_item_id="folder-1")

    class Storage:
        def delete_file_from_folder(self, **kwargs):
            calls.append(kwargs)

    monkeypatch.setattr(sites, "ProjectFolderService", Folders)
    monkeypatch.setattr(sites, "ProjectStorageService", Storage)
    app = FastAPI()
    app.include_router(sites.router)
    app.dependency_overrides[get_db] = lambda: object()
    app.dependency_overrides[get_current_app_user] = lambda: SimpleNamespace(
        role=role, office_page_permissions=permissions,
    )
    response = TestClient(app).delete("/sites/7/documents/folders/dokumentation/items/file-1")
    assert response.status_code == expected
    if expected == 204:
        assert response.content == b""
        assert calls == [(7, "dokumentation", role), {
            "drive_id": "drive-1", "folder_item_id": "folder-1", "item_id": "file-1",
        }]
    else:
        assert calls == []


@pytest.mark.parametrize("item_id,expected", [("folder-2", 400), ("foreign-file-1", 404)])
def test_delete_rejects_folders_and_foreign_files(item_id, expected):
    graph = FakeGraphClient()
    service = ProjectStorageService(config=enabled_config(), graph_client=graph)
    with pytest.raises(HTTPException) as error:
        service.delete_file_from_folder(drive_id="drive-1", folder_item_id="folder-1", item_id=item_id)
    assert error.value.status_code == expected
    assert graph.deletes == []


def test_delete_does_not_hide_storage_failure():
    class FailingGraph(FakeGraphClient):
        def delete(self, path):
            raise MicrosoftGraphRequestError(403, "Access denied")

    service = ProjectStorageService(config=enabled_config(), graph_client=FailingGraph())
    with pytest.raises(HTTPException):
        service.delete_file_from_folder(drive_id="drive-1", folder_item_id="folder-1", item_id="file-1")


def test_delete_is_disabled_in_isolated_local_calendar():
    graph = FakeGraphClient()
    service = ProjectStorageService(config=graph_config(), graph_client=graph)
    with pytest.raises(HTTPException) as error:
        service.delete_file_from_folder(drive_id="drive-1", folder_item_id="folder-1", item_id="file-1")
    assert error.value.status_code == 400
    assert graph.deletes == []
