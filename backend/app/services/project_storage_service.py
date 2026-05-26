from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException, status

from app.core.config import settings
from app.services.microsoft_graph_client import (
    MicrosoftGraphClient,
    MicrosoftGraphConfigError,
    MicrosoftGraphRequestError,
)
from app.services.project_folder_template import PROJECT_FOLDER_TEMPLATE

PROJECT_FOLDER_STATUS_DISABLED = "disabled"
PROJECT_FOLDER_STATUS_CREATED = "created"
PROJECT_FOLDER_STATUS_ERROR = "error"
MAX_PROJECT_FOLDER_NAME_LENGTH = 120


class ProjectStorageService:
    def __init__(self, graph_client: MicrosoftGraphClient | None = None, config=settings) -> None:
        self.config = config
        self.graph_client = graph_client or MicrosoftGraphClient(config=config)

    def test_project_storage_connection(self) -> dict[str, Any]:
        diagnostics: dict[str, Any] = {
            "connected": False,
            "graph_enabled": self.config.ms_graph_enabled,
            "config_loaded": False,
            "token_request_attempted": False,
            "token_acquired": False,
            "drive_check_attempted": False,
            "drive_check_status": None,
            "root_folder_check_attempted": False,
            "root_folder_check_status": None,
            "site_check_attempted": False,
            "site_check_status": None,
            "token_audience": None,
            "authorization_header_present": False,
            "authorization_header_scheme": None,
            "graph_base_url_used": self.config.ms_graph_base_url.rstrip("/"),
            "drive_url_shape": None,
            "microsoft_error_code": None,
            "microsoft_error_message_short": None,
            "failed_step": None,
        }
        if not self.config.ms_graph_enabled:
            return {
                **diagnostics,
                "reason": "MS_GRAPH_ENABLED is false",
            }

        missing = self._missing_project_config()
        if missing:
            return {
                **diagnostics,
                "config_loaded": False,
                "reason": "Missing Microsoft Graph configuration.",
                "missing_config": missing,
            }
        diagnostics["config_loaded"] = True

        try:
            diagnostics["token_request_attempted"] = True
            self.graph_client.get_access_token()
            diagnostics["token_acquired"] = True
            diagnostics["token_audience"] = getattr(self.graph_client, "token_audience", None)

            diagnostics["drive_check_attempted"] = True
            diagnostics["drive_url_shape"] = (
                f"GET {self.config.ms_graph_base_url.rstrip('/')}/drives/{{drive_id}}"
            )
            drive = self.graph_client.get(f"/drives/{self.config.ms_project_drive_id}")
            diagnostics["drive_check_status"] = 200

            diagnostics["root_folder_check_attempted"] = True
            root_folder = self.graph_client.get(
                f"/drives/{self.config.ms_project_drive_id}/items/{self.config.ms_project_root_folder_id}"
            )
            diagnostics["root_folder_check_status"] = 200

            site = None
            if self.config.ms_project_site_id:
                diagnostics["site_check_attempted"] = True
                site = self.graph_client.get(f"/sites/{self.config.ms_project_site_id}")
                diagnostics["site_check_status"] = 200
        except MicrosoftGraphConfigError as error:
            return {
                **diagnostics,
                "reason": "Missing Microsoft Graph configuration.",
                "missing_config": error.missing_config,
                "failed_step": "config",
            }
        except MicrosoftGraphRequestError as error:
            failed_step = _failed_step(diagnostics)
            request_diagnostics = getattr(error, "diagnostics", {})
            if isinstance(request_diagnostics, dict):
                diagnostics.update(request_diagnostics)
            return {
                **diagnostics,
                "reason": str(error),
                "status_code": error.status_code,
                "safe_error_code": error.error_code,
                "microsoft_error_code": error.error_code,
                "microsoft_error_message_short": error.error_message_short,
                "failed_step": failed_step,
                f"{failed_step}_error_status_code": error.status_code,
            }

        return {
            **diagnostics,
            "connected": True,
            "drive": _resource_summary(drive),
            "root_folder": _resource_summary(root_folder),
            "site": _resource_summary(site) if site else None,
        }

    def create_test_project_folder(self) -> dict[str, Any]:
        if not self.config.ms_graph_enabled:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "MS_GRAPH_ENABLED is false.")
        if not self.config.ms_graph_create_test_folders_enabled:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Test folder creation is disabled. "
                "Set MS_GRAPH_CREATE_TEST_FOLDERS_ENABLED=true to allow this admin test.",
            )
        missing = self._missing_project_config()
        if missing:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                f"Missing Microsoft Graph configuration: {', '.join(missing)}",
            )

        timestamp = datetime.now(UTC).strftime("%Y%m%d_%H%M%S")
        root_name = f"_TEST_Kalender_Graph_Integration_{timestamp}"
        root_folder = self._create_folder(self.config.ms_project_root_folder_id, root_name)
        root_folder_id = root_folder.get("id")
        if not isinstance(root_folder_id, str) or not root_folder_id:
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Microsoft Graph did not return folder id.")

        subfolders = []
        for template in PROJECT_FOLDER_TEMPLATE:
            folder_name = _project_subfolder_name(template)
            created = self._create_folder(root_folder_id, folder_name)
            subfolders.append(
                {
                    "sort_order": template["sort_order"],
                    "name": folder_name,
                    "id": created.get("id"),
                    "web_url": created.get("webUrl"),
                }
            )

        return {
            "created": True,
            "root_folder": {
                "id": root_folder.get("id"),
                "name": root_folder.get("name"),
                "web_url": root_folder.get("webUrl"),
            },
            "subfolders": subfolders,
        }

    def create_project_folder_for_site(
        self,
        *,
        site_id: int,
        site_number: str | None,
        site_name: str | None,
    ) -> dict[str, Any]:
        if not self.config.ms_graph_enabled or not self.config.ms_graph_create_project_folders_enabled:
            return {"status": PROJECT_FOLDER_STATUS_DISABLED}

        missing = self._missing_project_config()
        if missing:
            return {
                "status": PROJECT_FOLDER_STATUS_ERROR,
                "error": f"Missing Microsoft Graph configuration: {', '.join(missing)}",
            }

        folder_name = make_project_folder_name(
            site_id=site_id,
            site_number=site_number,
            site_name=site_name,
        )
        root_folder: dict[str, Any] | None = None
        try:
            root_folder = self._create_folder(self.config.ms_project_root_folder_id, folder_name)
            root_folder_id = root_folder.get("id")
            if not isinstance(root_folder_id, str) or not root_folder_id:
                raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Microsoft Graph did not return folder id.")

            subfolders = []
            for template in PROJECT_FOLDER_TEMPLATE:
                subfolder_name = _project_subfolder_name(template)
                created = self._create_folder(root_folder_id, subfolder_name)
                subfolders.append(
                    {
                        "sort_order": template["sort_order"],
                        "name": subfolder_name,
                        "id": created.get("id"),
                        "web_url": created.get("webUrl"),
                    }
                )
        except HTTPException as error:
            return {
                "status": PROJECT_FOLDER_STATUS_ERROR,
                "folder_id": root_folder.get("id") if root_folder else None,
                "folder_name": root_folder.get("name") if root_folder else folder_name,
                "web_url": root_folder.get("webUrl") if root_folder else None,
                "error": _safe_http_error_detail(error),
            }

        return {
            "status": PROJECT_FOLDER_STATUS_CREATED,
            "folder_id": root_folder.get("id"),
            "folder_name": root_folder.get("name"),
            "web_url": root_folder.get("webUrl"),
            "drive_id": self.config.ms_project_drive_id,
            "subfolders": subfolders,
        }

    def list_folder_children(self, *, drive_id: str | None, folder_item_id: str | None) -> list[dict[str, Any]]:
        if not self.config.ms_graph_enabled:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "MS_GRAPH_ENABLED is false.")
        if not drive_id or not folder_item_id:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "SharePoint-Ordner ist noch nicht angebunden.",
            )

        try:
            response = self.graph_client.get(
                f"/drives/{drive_id}/items/{folder_item_id}/children"
                "?$select=id,name,webUrl,size,lastModifiedDateTime,file,folder"
            )
        except MicrosoftGraphRequestError as error:
            raise _safe_graph_files_exception(error) from error

        items = response.get("value")
        if not isinstance(items, list):
            return []
        return [_document_item(item) for item in items if isinstance(item, dict)]

    def _create_folder(self, parent_item_id: str, name: str) -> dict[str, Any]:
        payload = {
            "name": name,
            "folder": {},
            "@microsoft.graph.conflictBehavior": "fail",
        }
        try:
            return self.graph_client.post(
                f"/drives/{self.config.ms_project_drive_id}/items/{parent_item_id}/children",
                payload,
            )
        except MicrosoftGraphRequestError as error:
            message = f"Microsoft Graph folder creation failed with status {error.status_code}."
            if error.error_code:
                message = f"{message} Code: {error.error_code}."
            if error.error_message_short:
                message = f"{message} {error.error_message_short}"
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, message) from error

    def _missing_project_config(self) -> list[str]:
        missing = [
            name
            for name, value in {
                "MS_TENANT_ID": self.config.ms_tenant_id,
                "MS_CLIENT_ID": self.config.ms_client_id,
                "MS_CLIENT_SECRET": self.config.ms_client_secret,
                "MS_PROJECT_DRIVE_ID": self.config.ms_project_drive_id,
                "MS_PROJECT_ROOT_FOLDER_ID": self.config.ms_project_root_folder_id,
            }.items()
            if not value
        ]
        return missing


def make_project_folder_name(*, site_id: int, site_number: str | None, site_name: str | None) -> str:
    parts = [part for part in [site_number, site_name] if part]
    raw_name = "_".join(parts) if parts else f"Baustelle_{site_id}"
    normalized = _normalize_sharepoint_folder_name(raw_name)
    return normalized or f"Baustelle_{site_id}"


def _normalize_sharepoint_folder_name(value: str) -> str:
    replacements = str.maketrans({
        "ä": "ae",
        "ö": "oe",
        "ü": "ue",
        "Ä": "Ae",
        "Ö": "Oe",
        "Ü": "Ue",
        "ß": "ss",
    })
    normalized = value.translate(replacements)
    normalized = re.sub(r"[^A-Za-z0-9_.-]+", "_", normalized)
    normalized = re.sub(r"[_.-]{2,}", "_", normalized)
    normalized = normalized.strip(" ._")
    return normalized[:MAX_PROJECT_FOLDER_NAME_LENGTH].strip(" ._")


def _project_subfolder_name(template: dict[str, Any]) -> str:
    return f"{template['sort_order']:02d}_{template['name']}"


def _resource_summary(resource: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": resource.get("id"),
        "name": resource.get("name") or resource.get("displayName"),
        "web_url": resource.get("webUrl"),
    }


def _document_item(item: dict[str, Any]) -> dict[str, Any]:
    name = item.get("name")
    file_info = item.get("file") if isinstance(item.get("file"), dict) else {}
    is_folder = isinstance(item.get("folder"), dict)
    return {
        "id": item.get("id") or "",
        "name": name or "Unbenannte Datei",
        "web_url": item.get("webUrl"),
        "size": item.get("size") if isinstance(item.get("size"), int) else None,
        "last_modified_date_time": item.get("lastModifiedDateTime"),
        "mime_type": file_info.get("mimeType"),
        "file_extension": _file_extension(name) if isinstance(name, str) and not is_folder else None,
        "is_folder": is_folder,
    }


def _file_extension(name: str) -> str | None:
    if "." not in name:
        return None
    extension = name.rsplit(".", 1)[-1].strip().lower()
    return extension or None


def _safe_graph_files_exception(error: MicrosoftGraphRequestError) -> HTTPException:
    status_code = status.HTTP_404_NOT_FOUND if error.status_code == 404 else status.HTTP_502_BAD_GATEWAY
    message = "SharePoint-Dateien konnten nicht geladen werden."
    if error.status_code:
        message = f"{message} Graph-Status: {error.status_code}."
    if error.error_code:
        message = f"{message} Code: {error.error_code}."
    if error.error_message_short:
        message = f"{message} {error.error_message_short}"
    return HTTPException(status_code, message[:240])


def _failed_step(diagnostics: dict[str, Any]) -> str:
    if diagnostics["token_request_attempted"] and not diagnostics["token_acquired"]:
        return "token"
    if diagnostics["drive_check_attempted"] and diagnostics["drive_check_status"] is None:
        return "drive"
    if diagnostics["root_folder_check_attempted"] and diagnostics["root_folder_check_status"] is None:
        return "root_folder"
    if diagnostics["site_check_attempted"] and diagnostics["site_check_status"] is None:
        return "site"
    return "unknown"


def _safe_http_error_detail(error: HTTPException) -> str:
    detail = error.detail if isinstance(error.detail, str) else "Microsoft Graph folder creation failed."
    return detail[:240]
