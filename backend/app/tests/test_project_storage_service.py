from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.services.microsoft_graph_client import MicrosoftGraphRequestError
from app.services.project_storage_service import ProjectStorageService


def graph_config(**overrides):
    defaults = {
        "ms_graph_enabled": False,
        "ms_graph_create_test_folders_enabled": False,
        "ms_tenant_id": None,
        "ms_client_id": None,
        "ms_client_secret": None,
        "ms_project_site_id": None,
        "ms_project_drive_id": None,
        "ms_project_root_folder_id": None,
        "ms_graph_timeout_seconds": 15.0,
        "ms_graph_base_url": "https://graph.microsoft.com/v1.0",
    }
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


class FakeGraphClient:
    def __init__(self):
        self.posts = []

    def get_access_token(self):
        return "token-not-returned"

    def get(self, path):
        if path == "/drives/drive-1":
            return {"id": "drive-1", "name": "Projekte"}
        if path == "/drives/drive-1/items/root-1":
            return {"id": "root-1", "name": "Projektbasis", "webUrl": "https://example.invalid/root"}
        if path == "/sites/site-1":
            return {"id": "site-1", "displayName": "SharePoint Site"}
        raise AssertionError(f"unexpected get path: {path}")

    def post(self, path, payload):
        self.posts.append((path, payload))
        index = len(self.posts)
        return {
            "id": f"folder-{index}",
            "name": payload["name"],
            "webUrl": f"https://example.invalid/folder-{index}",
        }


class FailingTokenGraphClient:
    def get_access_token(self):
        raise MicrosoftGraphRequestError(401, "Microsoft Graph token request failed with status 401.", error_code="invalid_client")


class FailingDriveGraphClient:
    def get_access_token(self):
        return "token-not-returned"

    def get(self, path):
        if path == "/drives/drive-1":
            raise MicrosoftGraphRequestError(401, "Microsoft Graph request failed with status 401.", error_code="InvalidAuthenticationToken")
        raise AssertionError(f"unexpected get path: {path}")



def enabled_config(**overrides):
    return graph_config(
        ms_graph_enabled=True,
        ms_tenant_id="tenant-1",
        ms_client_id="client-1",
        ms_client_secret="super-secret-value",
        ms_project_site_id="site-1",
        ms_project_drive_id="drive-1",
        ms_project_root_folder_id="root-1",
        **overrides,
    )


def test_connection_test_is_inert_when_graph_is_disabled():
    result = ProjectStorageService(config=graph_config()).test_project_storage_connection()

    assert result["connected"] is False
    assert result["graph_enabled"] is False
    assert result["reason"] == "MS_GRAPH_ENABLED is false"
    assert result["token_request_attempted"] is False


def test_connection_test_reports_missing_config_without_secret_values():
    result = ProjectStorageService(config=graph_config(ms_graph_enabled=True)).test_project_storage_connection()

    assert result["connected"] is False
    assert result["graph_enabled"] is True
    assert result["config_loaded"] is False
    assert "MS_CLIENT_SECRET" in result["missing_config"]
    assert "super-secret-value" not in str(result)


def test_connection_test_reads_drive_root_and_optional_site():
    result = ProjectStorageService(
        config=enabled_config(),
        graph_client=FakeGraphClient(),
    ).test_project_storage_connection()

    assert result["connected"] is True
    assert result["config_loaded"] is True
    assert result["token_request_attempted"] is True
    assert result["token_acquired"] is True
    assert result["drive_check_status"] == 200
    assert result["root_folder_check_status"] == 200
    assert result["site_check_status"] == 200
    assert result["drive"]["name"] == "Projekte"
    assert result["root_folder"]["name"] == "Projektbasis"
    assert result["site"]["name"] == "SharePoint Site"


def test_create_test_project_folder_is_blocked_without_feature_flag():
    service = ProjectStorageService(config=enabled_config(), graph_client=FakeGraphClient())

    with pytest.raises(HTTPException) as error:
        service.create_test_project_folder()

    assert error.value.status_code == 400
    assert "MS_GRAPH_CREATE_TEST_FOLDERS_ENABLED" in error.value.detail


def test_create_test_project_folder_creates_root_and_15_subfolders():
    graph = FakeGraphClient()
    service = ProjectStorageService(
        config=enabled_config(ms_graph_create_test_folders_enabled=True),
        graph_client=graph,
    )

    result = service.create_test_project_folder()

    assert result["created"] is True
    assert result["root_folder"]["name"].startswith("_TEST_Kalender_Graph_Integration_")
    assert len(result["subfolders"]) == 15
    assert result["subfolders"][0]["name"] == "01_Angebote"
    assert result["subfolders"][-1]["name"] == "15_Mails"
    assert len(graph.posts) == 16
    assert "super-secret-value" not in str(result)


def test_connection_test_reports_token_failure_step_without_secrets():
    result = ProjectStorageService(
        config=enabled_config(),
        graph_client=FailingTokenGraphClient(),
    ).test_project_storage_connection()

    assert result["connected"] is False
    assert result["config_loaded"] is True
    assert result["token_request_attempted"] is True
    assert result["token_acquired"] is False
    assert result["failed_step"] == "token"
    assert result["token_error_status_code"] == 401
    assert result["safe_error_code"] == "invalid_client"
    assert "super-secret-value" not in str(result)


def test_connection_test_reports_drive_failure_step_without_secrets():
    result = ProjectStorageService(
        config=enabled_config(),
        graph_client=FailingDriveGraphClient(),
    ).test_project_storage_connection()

    assert result["connected"] is False
    assert result["token_acquired"] is True
    assert result["drive_check_attempted"] is True
    assert result["drive_check_status"] is None
    assert result["failed_step"] == "drive"
    assert result["drive_error_status_code"] == 401
    assert result["safe_error_code"] == "InvalidAuthenticationToken"
    assert "super-secret-value" not in str(result)
