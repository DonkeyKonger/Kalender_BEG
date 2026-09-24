from types import SimpleNamespace

import pytest
from fastapi import BackgroundTasks, HTTPException

from app.api.routes import sites
from app.services.project_storage_service import ProjectStorageService
from app.services.microsoft_graph_client import MicrosoftGraphRequestError


BASE = "https://graph.microsoft.com/v1.0"


def make_service(pages):
    calls = []

    class Graph:
        def get(self, path):
            calls.append(path)
            value = pages[path]
            if isinstance(value, Exception):
                raise value
            return value

    service = ProjectStorageService(graph_client=Graph(), config=SimpleNamespace(ms_graph_enabled=True, ms_graph_base_url=BASE))
    return service, calls


def path(item):
    return f"/drives/drive/items/{item}/children?$select=id,file,folder,remoteItem"


def test_count_includes_all_pages_and_descendants_but_not_folders_or_shortcuts():
    next_page = "/drives/drive/items/root/children?$skiptoken=next"
    service, calls = make_service({
        path("root"): {"value": [{"id": "a", "file": {}}, {"id": "sub", "folder": {}}], "@odata.nextLink": BASE + next_page},
        next_page: {"value": [{"id": "b", "file": {}}, {"id": "a", "file": {}}, {"id": "link", "remoteItem": {"folder": {}}}]},
        path("sub"): {"value": [{"id": "deep", "folder": {}}, {"id": "c", "file": {}}]},
        path("deep"): {"value": [{"id": "d", "file": {}}, {"id": "empty", "folder": {}}, {"id": "root", "folder": {}}]},
        path("empty"): {"value": []},
    })
    assert service.count_folder_files(drive_id="drive", folder_item_id="root") == 4
    assert len(calls) == 5


def test_empty_folder_counts_zero():
    service, _ = make_service({path("root"): {"value": []}})
    assert service.count_folder_files(drive_id="drive", folder_item_id="root") == 0


def test_unavailable_storage_and_invalid_responses_do_not_claim_zero():
    service, calls = make_service({path("root"): {}})
    for drive_id, folder_item_id in [(None, "root"), ("drive", None)]:
        with pytest.raises(HTTPException):
            service.count_folder_files(drive_id=drive_id, folder_item_id=folder_item_id)
    assert calls == []
    with pytest.raises(HTTPException):
        service.count_folder_files(drive_id="drive", folder_item_id="root")
    service.config.ms_graph_enabled = False
    with pytest.raises(HTTPException):
        service.count_folder_files(drive_id="drive", folder_item_id="root")


def test_large_tree_deadline_fails_without_partial_count(monkeypatch):
    service, calls = make_service({})
    times = iter([0, 21])
    monkeypatch.setattr("app.services.project_storage_service.monotonic", lambda: next(times))
    with pytest.raises(HTTPException) as error:
        service.count_folder_files(drive_id="drive", folder_item_id="root")
    assert error.value.status_code == 503
    assert calls == []


@pytest.mark.parametrize("next_link", ["https://evil.invalid/page", BASE + "/drives/other/items/root/children?page=2", BASE + path("root")])
def test_rejects_foreign_or_repeating_pagination(next_link):
    service, calls = make_service({path("root"): {"value": [], "@odata.nextLink": next_link}})
    with pytest.raises(HTTPException):
        service.count_folder_files(drive_id="drive", folder_item_id="root")
    assert len(calls) == 1


def test_failed_subtree_never_returns_partial_count():
    service, _ = make_service({
        path("root"): {"value": [{"id": "a", "file": {}}, {"id": "sub", "folder": {}}]},
        path("sub"): MicrosoftGraphRequestError(503, "Unavailable"),
    })
    with pytest.raises(HTTPException):
        service.count_folder_files(drive_id="drive", folder_item_id="root")


def test_count_route_checks_folder_access_before_storage(monkeypatch):
    calls = []
    user = object()

    class Folders:
        def __init__(self, db): pass
        def get_project_folder_for_site_by_key(self, site_id, key, current_user):
            calls.append((site_id, key, current_user))
            return SimpleNamespace(external_drive_id="drive", external_item_id="root")

    def cached(db, site_id, folder, tasks):
        calls.append({"drive_id": folder.external_drive_id, "folder_item_id": folder.external_item_id})
        return {"file_count": 7, "refreshing": True}

    monkeypatch.setattr(sites, "ProjectFolderService", Folders)
    monkeypatch.setattr(sites, "read_and_refresh", cached)
    assert sites.get_project_folder_file_count(42, "fotos", BackgroundTasks(), user, None).file_count == 7
    assert calls == [(42, "fotos", user), {"drive_id": "drive", "folder_item_id": "root"}]

    def denied(*args): raise HTTPException(403, "Forbidden")
    monkeypatch.setattr(Folders, "get_project_folder_for_site_by_key", denied)
    calls.clear()
    with pytest.raises(HTTPException) as error:
        sites.get_project_folder_file_count(42, "fotos", BackgroundTasks(), user, None)
    assert error.value.status_code == 403
    assert calls == []
