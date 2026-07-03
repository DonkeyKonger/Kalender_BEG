from __future__ import annotations

import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote

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
PROJECT_FOLDER_ARCHIVE_FOLDER_NAME = "Archiv"
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
        project_manager_name: str | None = None,
        project_manager_id: int | None = None,
        is_archived: bool = False,
        existing_folder_id: str | None = None,
    ) -> dict[str, Any]:
        return self.sync_project_folder_for_site(
            site_id=site_id,
            site_number=site_number,
            site_name=site_name,
            project_manager_name=project_manager_name,
            project_manager_id=project_manager_id,
            is_archived=is_archived,
            existing_folder_id=existing_folder_id,
        )

    def sync_project_folder_for_site(
        self,
        *,
        site_id: int,
        site_number: str | None,
        site_name: str | None,
        project_manager_name: str | None,
        project_manager_id: int | None = None,
        is_archived: bool = False,
        existing_folder_id: str | None = None,
    ) -> dict[str, Any]:
        if not self.config.ms_graph_enabled or not self.config.ms_graph_create_project_folders_enabled:
            return {"status": PROJECT_FOLDER_STATUS_DISABLED}

        missing = self._missing_project_config()
        if missing:
            return {
                "status": PROJECT_FOLDER_STATUS_ERROR,
                "error": f"Missing Microsoft Graph configuration: {', '.join(missing)}",
            }

        target = project_folder_target(
            site_id=site_id,
            site_number=site_number,
            site_name=site_name,
            project_manager_name=project_manager_name,
            project_manager_id=project_manager_id,
            is_archived=is_archived,
        )
        folder_name = target["site_folder_name"]
        root_folder: dict[str, Any] | None = None
        try:
            parent_folder_id = self.config.ms_project_root_folder_id
            if is_archived:
                archive_folder = self._ensure_folder(
                    parent_folder_id,
                    PROJECT_FOLDER_ARCHIVE_FOLDER_NAME,
                )
                parent_folder_id = _folder_id_or_raise(archive_folder)

            project_manager_folder = self._ensure_folder(
                parent_folder_id,
                target["project_manager_folder_name"],
            )
            parent_folder_id = _folder_id_or_raise(project_manager_folder)

            root_folder = self._resolve_site_folder(
                target_parent_item_id=parent_folder_id,
                folder_name=folder_name,
                existing_folder_id=existing_folder_id,
            )
            root_folder_id = root_folder.get("id")
            if not isinstance(root_folder_id, str) or not root_folder_id:
                raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Microsoft Graph did not return folder id.")

            subfolders = []
            for template in PROJECT_FOLDER_TEMPLATE:
                subfolder_name = _project_subfolder_name(template)
                created = self._ensure_folder(root_folder_id, subfolder_name)
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
            "target_path": target["target_path"],
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

    def list_folder_item_children(
        self,
        *,
        drive_id: str | None,
        root_folder_item_id: str | None,
        item_id: str,
    ) -> list[dict[str, Any]]:
        if not self.config.ms_graph_enabled:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "MS_GRAPH_ENABLED is false.")
        if not drive_id or not root_folder_item_id:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "SharePoint-Ordner ist noch nicht angebunden.",
            )

        folder_item = self._get_descendant_drive_item(
            drive_id=drive_id,
            root_folder_item_id=root_folder_item_id,
            item_id=item_id,
        )
        if not isinstance(folder_item.get("folder"), dict):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Ausgewähltes Element ist kein Ordner.")
        return self.list_folder_children(drive_id=drive_id, folder_item_id=item_id)

    def download_file_from_folder(
        self,
        *,
        drive_id: str | None,
        folder_item_id: str | None,
        item_id: str,
    ) -> dict[str, Any]:
        if not self.config.ms_graph_enabled:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "MS_GRAPH_ENABLED is false.")
        if not drive_id or not folder_item_id:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "SharePoint-Ordner ist noch nicht angebunden.",
            )

        document = self.get_file_item_from_folder(
            drive_id=drive_id,
            folder_item_id=folder_item_id,
            item_id=item_id,
        )

        encoded_item_id = quote(item_id, safe="")
        try:
            content, content_type = self.graph_client.get_content(
                f"/drives/{drive_id}/items/{encoded_item_id}/content"
            )
        except MicrosoftGraphRequestError as error:
            raise _safe_graph_files_exception(error) from error

        return {
            "content": content,
            "content_type": content_type or document.get("mime_type") or "application/octet-stream",
            "filename": document.get("name") or "download",
        }

    def get_file_item_from_folder(
        self,
        *,
        drive_id: str | None,
        folder_item_id: str | None,
        item_id: str,
    ) -> dict[str, Any]:
        if not self.config.ms_graph_enabled:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "MS_GRAPH_ENABLED is false.")
        if not drive_id or not folder_item_id:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "SharePoint-Ordner ist noch nicht angebunden.",
            )

        drive_item = self._get_descendant_drive_item(
            drive_id=drive_id,
            root_folder_item_id=folder_item_id,
            item_id=item_id,
        )
        if isinstance(drive_item.get("folder"), dict):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Ordner können nicht heruntergeladen werden.")
        return _document_item(drive_item)

    def delete_file_from_folder(
        self,
        *,
        drive_id: str | None,
        folder_item_id: str | None,
        item_id: str,
    ) -> None:
        if not self.config.ms_graph_enabled:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "MS_GRAPH_ENABLED is false.")
        if not drive_id or not folder_item_id:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "SharePoint-Ordner ist noch nicht angebunden.",
            )

        encoded_item_id = quote(item_id, safe="")
        try:
            drive_item = self.graph_client.get(
                f"/drives/{drive_id}/items/{encoded_item_id}"
                "?$select=id,name,webUrl,size,lastModifiedDateTime,file,folder,parentReference"
            )
        except MicrosoftGraphRequestError as error:
            if error.status_code == 404:
                return
            raise _safe_graph_files_exception(error) from error
        if not isinstance(drive_item, dict) or not drive_item.get("id"):
            return
        if drive_item.get("id") == folder_item_id or isinstance(drive_item.get("folder"), dict):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Ordner können nicht gelöscht werden.")
        if not self._is_item_inside_folder(
            drive_id=drive_id,
            root_folder_item_id=folder_item_id,
            item=drive_item,
        ):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Datei nicht gefunden.")

        try:
            self.graph_client.delete(f"/drives/{drive_id}/items/{encoded_item_id}")
        except MicrosoftGraphRequestError as error:
            if error.status_code == 404:
                return
            raise _safe_graph_files_exception(error) from error

    def _get_descendant_drive_item(
        self,
        *,
        drive_id: str,
        root_folder_item_id: str,
        item_id: str,
    ) -> dict[str, Any]:
        drive_item = self._get_drive_item(drive_id=drive_id, item_id=item_id)
        if drive_item.get("id") == root_folder_item_id:
            return drive_item
        if not self._is_item_inside_folder(
            drive_id=drive_id,
            root_folder_item_id=root_folder_item_id,
            item=drive_item,
        ):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Datei nicht gefunden.")
        return drive_item

    def _is_item_inside_folder(
        self,
        *,
        drive_id: str,
        root_folder_item_id: str,
        item: dict[str, Any],
    ) -> bool:
        parent_id = _parent_reference_id(item)
        seen: set[str] = set()
        for _ in range(40):
            if not parent_id:
                return False
            if parent_id == root_folder_item_id:
                return True
            if parent_id in seen:
                return False
            seen.add(parent_id)
            parent = self._get_drive_item(drive_id=drive_id, item_id=parent_id)
            parent_id = _parent_reference_id(parent)
        return False

    def _get_drive_item(self, *, drive_id: str, item_id: str) -> dict[str, Any]:
        encoded_item_id = quote(item_id, safe="")
        try:
            drive_item = self.graph_client.get(
                f"/drives/{drive_id}/items/{encoded_item_id}"
                "?$select=id,name,webUrl,size,lastModifiedDateTime,file,folder,parentReference"
            )
        except MicrosoftGraphRequestError as error:
            raise _safe_graph_files_exception(error) from error
        if not isinstance(drive_item, dict) or not drive_item.get("id"):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Datei nicht gefunden.")
        return drive_item

    def upload_file_to_folder(
        self,
        *,
        drive_id: str | None,
        folder_item_id: str | None,
        filename: str | None,
        content: bytes,
        content_type: str | None = None,
    ) -> dict[str, Any]:
        if not self.config.ms_graph_enabled:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "MS_GRAPH_ENABLED is false.")
        if not drive_id or not folder_item_id:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "SharePoint-Ordner ist noch nicht angebunden.",
            )
        safe_filename = _safe_upload_filename(filename)
        if not safe_filename:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Dateiname fehlt.")

        encoded_filename = quote(safe_filename, safe="")
        try:
            response = self.graph_client.put_content(
                f"/drives/{drive_id}/items/{folder_item_id}:/{encoded_filename}:/content",
                content,
                content_type=content_type,
            )
        except MicrosoftGraphRequestError as error:
            raise _safe_graph_files_exception(error) from error
        return _document_item(response)

    def upload_file_to_folder_without_overwrite(
        self,
        *,
        drive_id: str | None,
        folder_item_id: str | None,
        filename: str | None,
        content: bytes,
        content_type: str | None = None,
    ) -> dict[str, Any]:
        safe_filename = _safe_upload_filename(filename)
        if not safe_filename:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Dateiname fehlt.")

        existing_names = {
            str(item.get("name") or "")
            for item in self.list_folder_children(drive_id=drive_id, folder_item_id=folder_item_id)
        }
        upload_filename = _unique_upload_filename(safe_filename, existing_names)
        return self.upload_file_to_folder(
            drive_id=drive_id,
            folder_item_id=folder_item_id,
            filename=upload_filename,
            content=content,
            content_type=content_type,
        )

    def _resolve_site_folder(
        self,
        *,
        target_parent_item_id: str,
        folder_name: str,
        existing_folder_id: str | None,
    ) -> dict[str, Any]:
        if existing_folder_id:
            existing = self._try_get_drive_item(existing_folder_id)
            if existing is not None and isinstance(existing.get("folder"), dict):
                current_parent_id = _parent_reference_id(existing)
                current_name = existing.get("name")
                if current_parent_id != target_parent_item_id or current_name != folder_name:
                    return self._move_or_rename_folder(
                        item_id=existing_folder_id,
                        target_parent_item_id=target_parent_item_id,
                        folder_name=folder_name,
                    )
                return existing

        target_existing = self._find_child_folder(target_parent_item_id, folder_name)
        if target_existing is not None:
            return target_existing

        flat_existing = self._find_child_folder(self.config.ms_project_root_folder_id, folder_name)
        if flat_existing is not None:
            return self._move_or_rename_folder(
                item_id=str(flat_existing["id"]),
                target_parent_item_id=target_parent_item_id,
                folder_name=folder_name,
            )

        return self._create_folder(target_parent_item_id, folder_name)

    def _ensure_folder(self, parent_item_id: str, folder_name: str) -> dict[str, Any]:
        existing = self._find_child_folder(parent_item_id, folder_name)
        if existing is not None:
            return existing
        return self._create_folder(parent_item_id, folder_name)

    def _find_child_folder(self, parent_item_id: str, folder_name: str) -> dict[str, Any] | None:
        encoded_parent_id = quote(parent_item_id, safe="")
        try:
            response = self.graph_client.get(
                f"/drives/{self.config.ms_project_drive_id}/items/{encoded_parent_id}/children"
                "?$select=id,name,webUrl,folder,parentReference"
            )
        except MicrosoftGraphRequestError as error:
            raise _safe_graph_files_exception(error) from error

        items = response.get("value")
        if not isinstance(items, list):
            return None
        expected = folder_name.casefold()
        for item in items:
            if not isinstance(item, dict) or not isinstance(item.get("folder"), dict):
                continue
            item_name = item.get("name")
            if isinstance(item_name, str) and item_name.casefold() == expected and item.get("id"):
                return item
        return None

    def _try_get_drive_item(self, item_id: str) -> dict[str, Any] | None:
        encoded_item_id = quote(item_id, safe="")
        try:
            item = self.graph_client.get(
                f"/drives/{self.config.ms_project_drive_id}/items/{encoded_item_id}"
                "?$select=id,name,webUrl,folder,parentReference"
            )
        except MicrosoftGraphRequestError as error:
            if error.status_code == 404:
                return None
            raise _safe_graph_files_exception(error) from error
        if not isinstance(item, dict) or not item.get("id"):
            return None
        return item

    def _move_or_rename_folder(
        self,
        *,
        item_id: str,
        target_parent_item_id: str,
        folder_name: str,
    ) -> dict[str, Any]:
        encoded_item_id = quote(item_id, safe="")
        payload = {
            "name": folder_name,
            "parentReference": {"id": target_parent_item_id},
        }
        try:
            return self.graph_client.patch(
                f"/drives/{self.config.ms_project_drive_id}/items/{encoded_item_id}",
                payload,
            )
        except MicrosoftGraphRequestError as error:
            message = f"Microsoft Graph folder move failed with status {error.status_code}."
            if error.error_code:
                message = f"{message} Code: {error.error_code}."
            if error.error_message_short:
                message = f"{message} {error.error_message_short}"
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, message) from error

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


def make_project_manager_folder_name(
    *, project_manager_name: str | None, project_manager_id: int | None = None
) -> str:
    raw_name = project_manager_name or (
        f"Projektleiter_{project_manager_id}" if project_manager_id else "Ohne_Projektleiter"
    )
    normalized = _normalize_sharepoint_folder_name(raw_name)
    return normalized or "Ohne_Projektleiter"


def project_folder_target(
    *,
    site_id: int,
    site_number: str | None,
    site_name: str | None,
    project_manager_name: str | None,
    project_manager_id: int | None = None,
    is_archived: bool = False,
) -> dict[str, Any]:
    site_folder_name = make_project_folder_name(
        site_id=site_id,
        site_number=site_number,
        site_name=site_name,
    )
    project_manager_folder_name = make_project_manager_folder_name(
        project_manager_name=project_manager_name,
        project_manager_id=project_manager_id,
    )
    parent_path = [project_manager_folder_name]
    if is_archived:
        parent_path = [PROJECT_FOLDER_ARCHIVE_FOLDER_NAME, project_manager_folder_name]
    return {
        "site_folder_name": site_folder_name,
        "project_manager_folder_name": project_manager_folder_name,
        "target_path": [*parent_path, site_folder_name],
        "is_archived": is_archived,
    }


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


def _folder_id_or_raise(item: dict[str, Any]) -> str:
    folder_id = item.get("id")
    if not isinstance(folder_id, str) or not folder_id:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Microsoft Graph did not return folder id.")
    return folder_id


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


def _parent_reference_id(item: dict[str, Any]) -> str | None:
    parent_reference = item.get("parentReference")
    if not isinstance(parent_reference, dict):
        return None
    parent_id = parent_reference.get("id")
    return parent_id if isinstance(parent_id, str) and parent_id else None


def _safe_upload_filename(filename: str | None) -> str:
    if not filename:
        return ""
    sanitized = filename.replace("\\", "/").split("/")[-1].strip(" .")
    return sanitized[:180].strip(" .")


def _unique_upload_filename(filename: str, existing_names: set[str]) -> str:
    if filename not in existing_names:
        return filename

    path = Path(filename)
    suffix = path.suffix
    stem = path.stem if suffix else filename
    timestamp = datetime.now(UTC).strftime("%Y%m%d_%H%M%S")
    for counter in range(1, 1000):
        counter_suffix = "" if counter == 1 else f"_{counter:02d}"
        candidate = f"{stem}_{timestamp}{counter_suffix}{suffix}"
        if candidate not in existing_names:
            return candidate
    raise HTTPException(status.HTTP_409_CONFLICT, "Eindeutiger Dateiname konnte nicht erzeugt werden.")


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
