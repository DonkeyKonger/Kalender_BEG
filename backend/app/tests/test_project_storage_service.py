import hashlib
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
        self.deletes = []
        self.patches = []

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
            "?$select=id,name,webUrl,size,createdDateTime,lastModifiedDateTime,file,folder"
        ):
            return {
                "value": [
                    {
                        "id": "file-1",
                        "name": "Angebot.pdf",
                        "webUrl": "https://example.invalid/angebot",
                        "size": 123456,
                        "createdDateTime": "2026-05-25T07:15:00Z",
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
        if path == (
            "/drives/drive-1/items/folder-2/children"
            "?$select=id,name,webUrl,size,createdDateTime,lastModifiedDateTime,file,folder"
        ):
            return {
                "value": [
                    {
                        "id": "nested-file-1",
                        "name": "Zeichnung.png",
                        "webUrl": "https://example.invalid/zeichnung",
                        "size": 2345,
                        "createdDateTime": "2026-05-24T09:45:00Z",
                        "lastModifiedDateTime": "2026-05-26T10:30:00Z",
                        "file": {"mimeType": "image/png"},
                    }
                ]
            }
        if path == (
            "/drives/drive-1/items/file-1"
            "?$select=id,name,webUrl,size,createdDateTime,lastModifiedDateTime,file,folder,parentReference"
        ):
            return {
                "id": "file-1",
                "name": "Angebot.pdf",
                "webUrl": "https://example.invalid/angebot",
                "size": 123456,
                "createdDateTime": "2026-05-25T07:15:00Z",
                "lastModifiedDateTime": "2026-05-26T08:30:00Z",
                "file": {"mimeType": "application/pdf"},
                "parentReference": {"id": "folder-1"},
            }
        if path == (
            "/drives/drive-1/items/folder-2"
            "?$select=id,name,webUrl,size,createdDateTime,lastModifiedDateTime,file,folder,parentReference"
        ):
            return {
                "id": "folder-2",
                "name": "Unterlagen",
                "webUrl": "https://example.invalid/unterlagen",
                "folder": {},
                "parentReference": {"id": "folder-1"},
            }
        if path == (
            "/drives/drive-1/items/nested-file-1"
            "?$select=id,name,webUrl,size,createdDateTime,lastModifiedDateTime,file,folder,parentReference"
        ):
            return {
                "id": "nested-file-1",
                "name": "Zeichnung.png",
                "webUrl": "https://example.invalid/zeichnung",
                "size": 2345,
                "createdDateTime": "2026-05-24T09:45:00Z",
                "lastModifiedDateTime": "2026-05-26T10:30:00Z",
                "file": {"mimeType": "image/png"},
                "parentReference": {"id": "folder-2"},
            }
        if path == (
            "/drives/drive-1/items/foreign-file-1"
            "?$select=id,name,webUrl,size,createdDateTime,lastModifiedDateTime,file,folder,parentReference"
        ):
            return {
                "id": "foreign-file-1",
                "name": "Fremd.pdf",
                "file": {"mimeType": "application/pdf"},
                "parentReference": {"id": "foreign-folder-1"},
            }
        if path == (
            "/drives/drive-1/items/foreign-folder-1"
            "?$select=id,name,webUrl,size,createdDateTime,lastModifiedDateTime,file,folder,parentReference"
        ):
            return {
                "id": "foreign-folder-1",
                "name": "Fremder Ordner",
                "folder": {},
                "parentReference": {"id": "drive-root"},
            }
        if path == (
            "/drives/drive-1/items/drive-root"
            "?$select=id,name,webUrl,size,createdDateTime,lastModifiedDateTime,file,folder,parentReference"
        ):
            return {
                "id": "drive-root",
                "name": "Drive Root",
                "folder": {},
            }
        if path.startswith("/drives/drive-1/items/") and path.endswith(
            "/children?$select=id,name,webUrl,folder,parentReference"
        ):
            return {"value": []}
        if path.startswith("/drives/drive-1/items/") and path.endswith(
            "/children?$select=id,name,webUrl,size,createdDateTime,lastModifiedDateTime,file,folder"
        ):
            return {"value": []}
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
        if path == "/drives/drive-1/items/nested-file-1/content":
            return b"image-bytes", "image/png"
        return b"pdf-bytes", "application/pdf"

    def delete(self, path):
        self.deletes.append(path)
        return {}

    def patch(self, path, payload):
        self.patches.append((path, payload))
        return {
            "id": path.rsplit("/", 1)[-1],
            "name": payload["name"],
            "webUrl": f"https://example.invalid/{payload['name']}",
            "folder": {},
            "parentReference": payload.get("parentReference"),
        }


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


def test_create_test_project_folder_creates_root_standard_and_extra_work_subfolder():
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
    assert result["nested_subfolders"] == [
        {
            "folder_key": "zusatzauftraege",
            "parent_folder_key": "aufmass",
            "name": "8.1 Zusatzaufträge",
            "id": "folder-17",
            "web_url": "https://example.invalid/folder-17",
        }
    ]
    assert graph.posts[-1][0] == "/drives/drive-1/items/folder-9/children"
    assert graph.posts[-1][1]["name"] == "8.1 Zusatzaufträge"
    assert len(graph.posts) == 17
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
        project_manager_name="Keno Erichsen",
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
        project_manager_name="Keno Erichsen",
    )

    assert result["status"] == "created"
    assert result["folder_name"] == "8007_Schuechtermann_Klinik"
    assert result["folder_id"] == "folder-2"
    assert result["web_url"] == "https://example.invalid/folder-2"
    assert result["drive_id"] == "drive-1"
    assert len(result["subfolders"]) == 15
    assert result["target_path"] == ["Keno_Erichsen", "8007_Schuechtermann_Klinik"]
    assert graph.posts[0][1]["name"] == "Keno_Erichsen"
    assert graph.posts[1][1]["name"] == "8007_Schuechtermann_Klinik"
    assert graph.posts[2][1]["name"] == "01_Angebote"
    assert graph.posts[4][1]["name"] == "03_Aufträge"
    assert graph.posts[-2][1]["name"] == "15_Mails"
    assert result["nested_subfolders"][0]["name"] == "8.1 Zusatzaufträge"
    assert graph.posts[-1][0] == "/drives/drive-1/items/folder-10/children"
    assert graph.posts[-1][1]["name"] == "8.1 Zusatzaufträge"
    assert len(graph.puts) == 1
    upload_path, upload_content, upload_content_type = graph.puts[0]
    assert upload_path == (
        "/drives/drive-1/items/folder-15:/Materialschein_Formular_Master.pdf:/content"
        "?@microsoft.graph.conflictBehavior=fail"
    )
    assert len(upload_content) == 548881
    assert hashlib.sha256(upload_content).hexdigest() == (
        "b39bfc26d8a644dff0492289f8909d1436a57236ccbddea9d2430216b1fdfe28"
    )
    assert upload_content_type == "application/pdf"
    assert "super-secret-value" not in str(result)


def test_create_project_folder_for_site_keeps_existing_material_order_template():
    class ExistingMaterialTemplateGraphClient(FakeGraphClient):
        def get(self, path):
            if path == (
                "/drives/drive-1/items/folder-15/children"
                "?$select=id,name,webUrl,size,createdDateTime,lastModifiedDateTime,file,folder"
            ):
                return {
                    "value": [
                        {
                            "id": "material-template-1",
                            "name": "Materialschein_Formular_Master.pdf",
                            "file": {"mimeType": "application/pdf"},
                        }
                    ]
                }
            return super().get(path)

    graph = ExistingMaterialTemplateGraphClient()
    result = ProjectStorageService(
        config=enabled_config(ms_graph_create_project_folders_enabled=True),
        graph_client=graph,
    ).create_project_folder_for_site(
        site_id=42,
        site_number="8007",
        site_name="Schüchtermann Klinik",
        project_manager_name="Keno Erichsen",
    )

    assert result["status"] == "created"
    assert len(result["subfolders"]) == 15
    assert graph.puts == []


def test_create_project_folder_for_site_tolerates_concurrent_material_template_upload():
    class ConcurrentMaterialTemplateGraphClient(FakeGraphClient):
        def put_content(self, path, content, content_type=None):
            raise MicrosoftGraphRequestError(
                409,
                "Microsoft Graph request failed with status 409.",
                error_code="nameAlreadyExists",
            )

    result = ProjectStorageService(
        config=enabled_config(ms_graph_create_project_folders_enabled=True),
        graph_client=ConcurrentMaterialTemplateGraphClient(),
    ).create_project_folder_for_site(
        site_id=42,
        site_number="8007",
        site_name="Schüchtermann Klinik",
        project_manager_name="Keno Erichsen",
    )

    assert result["status"] == "created"
    assert len(result["subfolders"]) == 15


def test_create_project_folder_for_site_logs_material_template_upload_failure(caplog):
    class FailingMaterialTemplateGraphClient(FakeGraphClient):
        def put_content(self, path, content, content_type=None):
            raise MicrosoftGraphRequestError(
                503,
                "Microsoft Graph request failed with status 503.",
                error_code="serviceNotAvailable",
            )

    graph = FailingMaterialTemplateGraphClient()
    with caplog.at_level("ERROR", logger="app.services.project_storage_service"):
        result = ProjectStorageService(
            config=enabled_config(ms_graph_create_project_folders_enabled=True),
            graph_client=graph,
        ).create_project_folder_for_site(
            site_id=42,
            site_number="8007",
            site_name="Schüchtermann Klinik",
            project_manager_name="Keno Erichsen",
        )

    assert result["status"] == "created"
    assert len(result["subfolders"]) == 15
    assert graph.posts[-2][1]["name"] == "15_Mails"
    assert graph.posts[-1][1]["name"] == "8.1 Zusatzaufträge"
    assert "Material order template upload failed for site 42" in caplog.text


def test_extra_work_archive_folder_is_created_on_demand_and_upload_is_idempotent():
    class PersistentFolderGraphClient(FakeGraphClient):
        def __init__(self):
            super().__init__()
            self.children_by_parent = {}

        def get(self, path):
            suffix = "/children?$select=id,name,webUrl,folder,parentReference"
            if path.startswith("/drives/drive-1/items/") and path.endswith(suffix):
                parent_id = path.removeprefix("/drives/drive-1/items/").removesuffix(suffix)
                return {"value": list(self.children_by_parent.get(parent_id, []))}
            return super().get(path)

        def post(self, path, payload):
            created = super().post(path, payload)
            created["folder"] = {}
            parent_id = path.removeprefix("/drives/drive-1/items/").removesuffix("/children")
            self.children_by_parent.setdefault(parent_id, []).append(created)
            return created

    graph = PersistentFolderGraphClient()
    service = ProjectStorageService(
        config=enabled_config(ms_graph_create_project_folders_enabled=True),
        graph_client=graph,
    )

    first = service.upload_extra_work_archive_pdf(
        project_folder_item_id="existing-project-root",
        filename="Zusatzauftrag_9999_9999.SZ03.pdf",
        content=b"first-current-pdf",
    )
    second = service.upload_extra_work_archive_pdf(
        project_folder_item_id="existing-project-root",
        filename="Zusatzauftrag_9999_9999.SZ03.pdf",
        content=b"corrected-current-pdf",
    )

    assert first["id"] == second["id"] == "uploaded-1"
    assert [payload["name"] for _, payload in graph.posts] == [
        "08_Aufmass",
        "8.1 Zusatzaufträge",
    ]
    assert len(graph.puts) == 2
    upload_paths = [path for path, _, _ in graph.puts]
    assert upload_paths == [
        "/drives/drive-1/items/folder-2:/Zusatzauftrag_9999_9999.SZ03.pdf:/content",
        "/drives/drive-1/items/folder-2:/Zusatzauftrag_9999_9999.SZ03.pdf:/content",
    ]
    assert graph.puts[-1][1] == b"corrected-current-pdf"


def test_sync_project_folder_for_site_moves_existing_flat_folder_to_project_manager_folder():
    class ExistingFlatFolderGraphClient(FakeGraphClient):
        def get(self, path):
            if path == (
                "/drives/drive-1/items/root-1/children"
                "?$select=id,name,webUrl,folder,parentReference"
            ):
                return {
                    "value": [
                        {
                            "id": "old-folder",
                            "name": "8007_Schuechtermann_Klinik",
                            "webUrl": "https://example.invalid/old-folder",
                            "folder": {},
                            "parentReference": {"id": "root-1"},
                        }
                    ]
                }
            return super().get(path)

    graph = ExistingFlatFolderGraphClient()

    result = ProjectStorageService(
        config=enabled_config(ms_graph_create_project_folders_enabled=True),
        graph_client=graph,
    ).sync_project_folder_for_site(
        site_id=42,
        site_number="8007",
        site_name="Schüchtermann Klinik",
        project_manager_name="Keno Erichsen",
    )

    assert result["status"] == "created"
    assert result["folder_id"] == "old-folder"
    assert result["target_path"] == ["Keno_Erichsen", "8007_Schuechtermann_Klinik"]
    assert graph.posts[0][1]["name"] == "Keno_Erichsen"
    assert graph.patches == [
        (
            "/drives/drive-1/items/old-folder",
            {
                "name": "8007_Schuechtermann_Klinik",
                "parentReference": {"id": "folder-1"},
            },
        )
    ]


def test_sync_project_folder_for_site_uses_archive_project_manager_path():
    graph = FakeGraphClient()

    result = ProjectStorageService(
        config=enabled_config(ms_graph_create_project_folders_enabled=True),
        graph_client=graph,
    ).sync_project_folder_for_site(
        site_id=42,
        site_number="8007",
        site_name="Schüchtermann Klinik",
        project_manager_name="Keno Erichsen",
        is_archived=True,
    )

    assert result["status"] == "created"
    assert result["target_path"] == ["Archiv", "Keno_Erichsen", "8007_Schuechtermann_Klinik"]
    assert graph.posts[0][1]["name"] == "Archiv"
    assert graph.posts[1][1]["name"] == "Keno_Erichsen"
    assert graph.posts[2][1]["name"] == "8007_Schuechtermann_Klinik"


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
        "created_date_time": "2026-05-25T07:15:00Z",
        "last_modified_date_time": "2026-05-26T08:30:00Z",
        "mime_type": "application/pdf",
        "file_extension": "pdf",
        "is_folder": False,
    }
    assert result[1]["name"] == "Unterlagen"
    assert result[1]["is_folder"] is True
    assert result[1]["file_extension"] is None
    assert "super-secret-value" not in str(result)


def test_list_folder_item_children_verifies_subfolder_inside_root():
    service = ProjectStorageService(
        config=enabled_config(),
        graph_client=FakeGraphClient(),
    )

    result = service.list_folder_item_children(
        drive_id="drive-1",
        root_folder_item_id="folder-1",
        item_id="folder-2",
    )

    assert result == [
        {
            "id": "nested-file-1",
            "name": "Zeichnung.png",
            "web_url": "https://example.invalid/zeichnung",
            "size": 2345,
            "created_date_time": "2026-05-24T09:45:00Z",
            "last_modified_date_time": "2026-05-26T10:30:00Z",
            "mime_type": "image/png",
            "file_extension": "png",
            "is_folder": False,
        }
    ]


def test_list_folder_item_children_rejects_file_item():
    service = ProjectStorageService(
        config=enabled_config(),
        graph_client=FakeGraphClient(),
    )

    with pytest.raises(HTTPException) as error:
        service.list_folder_item_children(
            drive_id="drive-1",
            root_folder_item_id="folder-1",
            item_id="file-1",
        )

    assert error.value.status_code == 400


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


def test_download_file_from_folder_allows_nested_file_inside_root():
    graph = FakeGraphClient()
    service = ProjectStorageService(
        config=enabled_config(),
        graph_client=graph,
    )

    result = service.download_file_from_folder(
        drive_id="drive-1",
        folder_item_id="folder-1",
        item_id="nested-file-1",
    )

    assert graph.downloads == ["/drives/drive-1/items/nested-file-1/content"]
    assert result["filename"] == "Zeichnung.png"
    assert result["content_type"] == "image/png"


def test_download_file_from_folder_rejects_item_outside_root_folder():
    service = ProjectStorageService(
        config=enabled_config(),
        graph_client=FakeGraphClient(),
    )

    with pytest.raises(HTTPException) as error:
        service.download_file_from_folder(
            drive_id="drive-1",
            folder_item_id="folder-1",
            item_id="foreign-file-1",
        )

    assert error.value.status_code == 404


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


def test_upload_file_to_folder_without_overwrite_adds_timestamp_when_name_exists():
    graph = FakeGraphClient()
    service = ProjectStorageService(
        config=enabled_config(),
        graph_client=graph,
    )

    service.upload_file_to_folder_without_overwrite(
        drive_id="drive-1",
        folder_item_id="folder-1",
        filename="Angebot.pdf",
        content=b"pdf-bytes",
        content_type="application/pdf",
    )

    assert len(graph.puts) == 1
    path, content, content_type = graph.puts[0]
    assert path.startswith("/drives/drive-1/items/folder-1:/Angebot_")
    assert path.endswith(".pdf:/content")
    assert content == b"pdf-bytes"
    assert content_type == "application/pdf"


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
        project_manager_name="Keno Erichsen",
    )

    assert result["status"] == "error"
    assert result["folder_name"] == "8007_Schuechtermann_Klinik"
    assert "accessDenied" in result["error"]
    assert "super-secret-value" not in str(result)


def test_delete_file_from_folder_deletes_descendant_file():
    graph = FakeGraphClient()
    service = ProjectStorageService(config=enabled_config(), graph_client=graph)

    service.delete_file_from_folder(
        drive_id="drive-1",
        folder_item_id="folder-1",
        item_id="nested-file-1",
    )

    assert graph.deletes == ["/drives/drive-1/items/nested-file-1"]


def test_delete_file_from_folder_ignores_missing_graph_item():
    class MissingFileGraphClient(FakeGraphClient):
        def get(self, path):
            if path == (
                "/drives/drive-1/items/missing-file-1"
                "?$select=id,name,webUrl,size,createdDateTime,lastModifiedDateTime,file,folder,parentReference"
            ):
                raise MicrosoftGraphRequestError(
                    404,
                    "Microsoft Graph request failed with status 404.",
                    error_code="itemNotFound",
                )
            return super().get(path)

    graph = MissingFileGraphClient()
    service = ProjectStorageService(config=enabled_config(), graph_client=graph)

    service.delete_file_from_folder(
        drive_id="drive-1",
        folder_item_id="folder-1",
        item_id="missing-file-1",
    )

    assert graph.deletes == []
