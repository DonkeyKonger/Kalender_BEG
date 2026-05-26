from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.services.microsoft_graph_client import MicrosoftGraphRequestError
from app.services.project_storage_service import ProjectStorageService


def graph_config(**overrides):
    defaults = {
        "ms_graph_enabled": False,
        "ms_graph_create_test_folders_enabled": False,
        "ms_graph_create_project_folders_enabled": False,
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
        self.puts = []
        self.downloads = []

    def get_access_token(self):
        return "token-not-returned"

    def get(self, path):
        if path == "/drives/drive-1":
            return {"id": "drive-1", "name": "Projekte"}
        if path == "/drives/drive-1/items/root-1":
            return {
                "id": "root-1",
                "name": "Projektbasis",
                "webUrl": "https://example.invalid/root",
            }
        if path == "/sites/site-1":
            return {"id": "site-1", "displayName": "SharePoint Site"}
        if path == (
            "/drives/drive-1/items/folder-1/children"
            "?$select=id,name,webUrl,size,lastModifiedDateTime,file,folder"
        ):
            return {
                "value": [
                    {
                        "id": "file-1",
                        "name": "Angebot.pdf",
                        "webUrl": "https://example.invalid/angebot",
                        "size": 123456,
                        "lastModifiedDateTime": "2026-05-26T08:30:00Z",
                        "file": {"mimeType": "application/pdf"},
                    },
                    {
                        "id": "folder-2",
                        "name": "Unterlagen",
                        "webUrl": "https://example.invalid/unterlagen",
                        "folder": {},
                    },
                ]
            }
        raise AssertionError(f"unexpected get path: {path}")

    def post(self, path, payload):
        self.posts.append((path, payload))
        index = len(self.posts)
        return {
            "id": f"folder-{index}",
            "name": payload["name"],
            "webUrl": f"https://example.invalid/folder-{index}",
        }

    def put_content(self, path, content, content_type=None):
        self.puts.append((path, content, content_type))
        return {
            "id": "uploaded-1",
            "name": "Upload.pdf",
            "webUrl": "https://example.invalid/upload",
            "size": len(content),
            "lastModifiedDateTime": "2026-05-26T09:15:00Z",
            "file": {"mimeType": content_type},
        }

    def get_content(self, path):
        self.downloads.append(path)
        return b"pdf-bytes", "application/pdf"


class FailingTokenGraphClient:
    def get_access_token(self):
        raise MicrosoftGraphRequestError(
            401,
            "Microsoft Graph token request failed with status 401.",
            error_code="invalid_client",
        )


class FailingDriveGraphClient:
    def get_access_token(self):
        return "token-not-returned"

    def get(self, path):
        if path == "/drives/drive-1":
            raise MicrosoftGraphRequestError(
                401,
                "Microsoft Graph request failed with status 401.",
                error_code="generalException",
                error_message_short="Drive request was unauthorized.",
                diagnostics={
                    "authorization_header_present": True,
                    "authorization_header_scheme": "Bearer",
                    "graph_base_url_used": "https://graph.microsoft.com/v1.0",
                    "drive_url_shape": "GET https://graph.microsoft.com/v1.0/drives/{drive_id}",
                },
            )
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
    result = ProjectStorageService(
        config=graph_config(ms_graph_enabled=True)
    ).test_project_storage_connection()

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
    assert result["safe_error_code"] == "generalException"
    assert result["microsoft_error_code"] == "generalException"
    assert result["microsoft_error_message_short"] == "Drive request was unauthorized."
    assert result["authorization_header_present"] is True
    assert result["authorization_header_scheme"] == "Bearer"
    assert result["graph_base_url_used"] == "https://graph.microsoft.com/v1.0"
    assert result["drive_url_shape"] == "GET https://graph.microsoft.com/v1.0/drives/{drive_id}"
    assert "super-secret-value" not in str(result)


def test_create_project_folder_for_site_is_blocked_without_project_feature_flag():
    graph = FakeGraphClient()
    result = ProjectStorageService(
        config=enabled_config(ms_graph_create_project_folders_enabled=False),
        graph_client=graph,
    ).create_project_folder_for_site(
        site_id=42,
        site_number="8007",
        site_name="Schüchtermann Klinik",
    )

    assert result == {"status": "disabled"}
    assert graph.posts == []


def test_create_project_folder_for_site_creates_sanitized_root_and_subfolders():
    graph = FakeGraphClient()
    result = ProjectStorageService(
        config=enabled_config(ms_graph_create_project_folders_enabled=True),
        graph_client=graph,
    ).create_project_folder_for_site(
        site_id=42,
        site_number="8007",
        site_name="Schüchtermann Klinik",
    )

    assert result["status"] == "created"
    assert result["folder_name"] == "8007_Schuechtermann_Klinik"
    assert result["folder_id"] == "folder-1"
    assert result["web_url"] == "https://example.invalid/folder-1"
    assert result["drive_id"] == "drive-1"
    assert len(result["subfolders"]) == 15
    assert graph.posts[0][1]["name"] == "8007_Schuechtermann_Klinik"
    assert graph.posts[1][1]["name"] == "01_Angebote"
    assert graph.posts[-1][1]["name"] == "15_Mails"
    assert "super-secret-value" not in str(result)


def test_list_folder_children_returns_safe_document_items():
    service = ProjectStorageService(
        config=enabled_config(),
        graph_client=FakeGraphClient(),
    )

    result = service.list_folder_children(drive_id="drive-1", folder_item_id="folder-1")

    assert result[0] == {
        "id": "file-1",
        "name": "Angebot.pdf",
        "web_url": "https://example.invalid/angebot",
        "size": 123456,
        "last_modified_date_time": "2026-05-26T08:30:00Z",
        "mime_type": "application/pdf",
        "file_extension": "pdf",
        "is_folder": False,
    }
    assert result[1]["name"] == "Unterlagen"
    assert result[1]["is_folder"] is True
    assert result[1]["file_extension"] is None
    assert "super-secret-value" not in str(result)


def test_download_file_from_folder_verifies_child_and_returns_content():
    graph = FakeGraphClient()
    service = ProjectStorageService(
        config=enabled_config(),
        graph_client=graph,
    )

    result = service.download_file_from_folder(
        drive_id="drive-1",
        folder_item_id="folder-1",
        item_id="file-1",
    )

    assert graph.downloads == ["/drives/drive-1/items/file-1/content"]
    assert result == {
        "content": b"pdf-bytes",
        "content_type": "application/pdf",
        "filename": "Angebot.pdf",
    }
    assert "super-secret-value" not in str(result)


def test_download_file_from_folder_rejects_subfolder_item():
    service = ProjectStorageService(
        config=enabled_config(),
        graph_client=FakeGraphClient(),
    )

    with pytest.raises(HTTPException) as error:
        service.download_file_from_folder(
            drive_id="drive-1",
            folder_item_id="folder-1",
            item_id="folder-2",
        )

    assert error.value.status_code == 400


def test_upload_file_to_folder_uses_encoded_filename_and_returns_document_item():
    graph = FakeGraphClient()
    service = ProjectStorageService(
        config=enabled_config(),
        graph_client=graph,
    )

    result = service.upload_file_to_folder(
        drive_id="drive-1",
        folder_item_id="folder-1",
        filename="Angebot Müller.pdf",
        content=b"pdf-bytes",
        content_type="application/pdf",
    )

    assert graph.puts == [
        (
            "/drives/drive-1/items/folder-1:/Angebot%20M%C3%BCller.pdf:/content",
            b"pdf-bytes",
            "application/pdf",
        )
    ]
    assert result["id"] == "uploaded-1"
    assert result["name"] == "Upload.pdf"
    assert result["file_extension"] == "pdf"
    assert result["mime_type"] == "application/pdf"
    assert result["is_folder"] is False
    assert "super-secret-value" not in str(result)


def test_create_project_folder_for_site_returns_error_without_raising():
    class FailingPostGraphClient(FakeGraphClient):
        def post(self, path, payload):
            raise MicrosoftGraphRequestError(
                403,
                "Microsoft Graph request failed with status 403.",
                error_code="accessDenied",
                error_message_short="Access denied.",
            )

    result = ProjectStorageService(
        config=enabled_config(ms_graph_create_project_folders_enabled=True),
        graph_client=FailingPostGraphClient(),
    ).create_project_folder_for_site(
        site_id=42,
        site_number="8007",
        site_name="Schüchtermann Klinik",
    )

    assert result["status"] == "error"
    assert result["folder_name"] == "8007_Schuechtermann_Klinik"
    assert "accessDenied" in result["error"]
    assert "super-secret-value" not in str(result)
