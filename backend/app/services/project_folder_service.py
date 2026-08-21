from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.enums import UserRole
from app.models.project_folder import ProjectFolder, ProjectFolderDocumentCaption
from app.models.site import Site
from app.models.user import User
from app.services.project_folder_template import (
    PROJECT_FOLDER_TEMPLATE,
    PROJECT_FOLDER_TEMPLATE_BY_KEY,
)

FULL_ACCESS_ROLES = {UserRole.ADMIN, UserRole.PROJECT_MANAGER, UserRole.OFFICE}


class ProjectFolderService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def create_default_project_folders_for_site(self, site_id: int) -> list[ProjectFolder]:
        self._ensure_site_exists(site_id)
        existing = self.db.scalars(
            select(ProjectFolder).where(ProjectFolder.site_id == site_id)
        ).all()
        existing_by_key = {folder.folder_key: folder for folder in existing}
        for template in PROJECT_FOLDER_TEMPLATE:
            folder = existing_by_key.get(template["folder_key"])
            if folder is not None and folder.name != template["name"]:
                folder.name = template["name"]
        created = []
        for template in PROJECT_FOLDER_TEMPLATE:
            if template["folder_key"] in existing_by_key:
                continue
            folder = ProjectFolder(
                site_id=site_id,
                sort_order=template["sort_order"],
                name=template["name"],
                folder_key=template["folder_key"],
                is_active=True,
            )
            self.db.add(folder)
            created.append(folder)
        if created or existing:
            self.db.flush()
        return [*existing, *created]

    def attach_external_subfolders_for_site(
        self,
        site_id: int,
        subfolders: list[dict[str, Any]],
        *,
        drive_id: str | None,
    ) -> None:
        folders = self.create_default_project_folders_for_site(site_id)
        folders_by_sort_order = {folder.sort_order: folder for folder in folders}
        for subfolder in subfolders:
            sort_order = subfolder.get("sort_order")
            if not isinstance(sort_order, int):
                continue
            folder = folders_by_sort_order.get(sort_order)
            if folder is None:
                continue
            folder.external_provider = "sharepoint"
            folder.external_drive_id = drive_id
            folder.external_item_id = subfolder.get("id")
            folder.external_web_url = subfolder.get("web_url")
        self.db.flush()

    def get_visible_project_folders_for_site(
        self, site_id: int, current_user: User
    ) -> list[ProjectFolder]:
        self.create_default_project_folders_for_site(site_id)
        folders = self.db.scalars(
            select(ProjectFolder)
            .where(ProjectFolder.site_id == site_id, ProjectFolder.is_active.is_(True))
            .order_by(ProjectFolder.sort_order, ProjectFolder.id)
        ).all()
        return [
            folder for folder in folders if user_can_access_project_folder(current_user, folder)
        ]

    def get_project_folder(self, folder_id: int, current_user: User) -> ProjectFolder:
        folder = self.db.get(ProjectFolder, folder_id)
        if folder is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Projektordner nicht gefunden.")
        if not user_can_access_project_folder(current_user, folder):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, "Keine Berechtigung fuer diesen Projektordner."
            )
        return folder

    def get_project_folder_for_site_by_key(
        self, site_id: int, folder_key: str, current_user: User
    ) -> ProjectFolder:
        self.create_default_project_folders_for_site(site_id)
        folder = self.db.scalar(
            select(ProjectFolder).where(
                ProjectFolder.site_id == site_id,
                ProjectFolder.folder_key == folder_key,
                ProjectFolder.is_active.is_(True),
            )
        )
        if folder is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Projektordner nicht gefunden.")
        if not user_can_access_project_folder(current_user, folder):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, "Keine Berechtigung fuer diesen Projektordner."
            )
        return folder

    def add_document_captions(
        self,
        *,
        site_id: int,
        folder_key: str,
        items: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        item_ids = [str(item.get("id")) for item in items if item.get("id")]
        if not item_ids:
            return [{**item, "caption": None} for item in items]
        captions = self.db.scalars(
            select(ProjectFolderDocumentCaption).where(
                ProjectFolderDocumentCaption.site_id == site_id,
                ProjectFolderDocumentCaption.folder_key == folder_key,
                ProjectFolderDocumentCaption.external_item_id.in_(item_ids),
            )
        ).all()
        caption_by_item_id = {
            record.external_item_id: record.caption for record in captions
        }
        return [
            {**item, "caption": caption_by_item_id.get(str(item.get("id")))}
            for item in items
        ]

    def update_document_caption(
        self,
        *,
        site_id: int,
        folder_key: str,
        item_id: str,
        caption: str | None,
    ) -> str | None:
        record = self.db.scalar(
            select(ProjectFolderDocumentCaption).where(
                ProjectFolderDocumentCaption.site_id == site_id,
                ProjectFolderDocumentCaption.folder_key == folder_key,
                ProjectFolderDocumentCaption.external_item_id == item_id,
            )
        )
        if caption is None:
            if record is not None:
                self.db.delete(record)
                self.db.commit()
            return None
        if record is None:
            record = ProjectFolderDocumentCaption(
                site_id=site_id,
                folder_key=folder_key,
                external_item_id=item_id,
                caption=caption,
            )
            self.db.add(record)
        else:
            record.caption = caption
        self.db.commit()
        return caption

    def _ensure_site_exists(self, site_id: int) -> None:
        if self.db.get(Site, site_id) is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Baustelle nicht gefunden.")


def user_can_access_project_folder(user: User, project_folder: ProjectFolder) -> bool:
    if not project_folder.is_active:
        return False
    if user.role in FULL_ACCESS_ROLES:
        return True
    template = PROJECT_FOLDER_TEMPLATE_BY_KEY.get(project_folder.folder_key)
    if template is None:
        return False
    return user.role.value in template["visible_for_roles"]
