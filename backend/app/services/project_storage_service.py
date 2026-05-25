from __future__ import annotations

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


class ProjectStorageService:
    def __init__(self, graph_client: MicrosoftGraphClient | None = None, config=settings) -> None:
        self.config = config
        self.graph_client = graph_client or MicrosoftGraphClient(config=config)

    def test_project_storage_connection(self) -> dict[str, Any]:
        if not self.config.ms_graph_enabled:
            return {
                "connected": False,
                "graph_enabled": False,
                "reason": "MS_GRAPH_ENABLED is false",
            }

        missing = self._missing_project_config()
        if missing:
            return {
                "connected": False,
                "graph_enabled": True,
                "reason": "Missing Microsoft Graph configuration.",
                "missing_config": missing,
            }

        try:
            self.graph_client.get_access_token()
            drive = self.graph_client.get(f"/drives/{self.config.ms_project_drive_id}")
            root_folder = self.graph_client.get(
                f"/drives/{self.config.ms_project_drive_id}/items/{self.config.ms_project_root_folder_id}"
            )
            site = None
            if self.config.ms_project_site_id:
                site = self.graph_client.get(f"/sites/{self.config.ms_project_site_id}")
        except MicrosoftGraphConfigError as error:
            return {
                "connected": False,
                "graph_enabled": True,
                "reason": "Missing Microsoft Graph configuration.",
                "missing_config": error.missing_config,
            }
        except MicrosoftGraphRequestError as error:
            return {
                "connected": False,
                "graph_enabled": True,
                "reason": str(error),
                "status_code": error.status_code,
            }

        return {
            "connected": True,
            "graph_enabled": True,
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
            folder_name = f"{template['sort_order']:02d}_{template['name']}"
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
            raise HTTPException(
                status.HTTP_502_BAD_GATEWAY,
                f"Microsoft Graph folder creation failed: {error}",
            ) from error

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


def _resource_summary(resource: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": resource.get("id"),
        "name": resource.get("name") or resource.get("displayName"),
        "web_url": resource.get("webUrl"),
    }
