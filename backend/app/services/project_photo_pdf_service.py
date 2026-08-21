from __future__ import annotations

from datetime import UTC, datetime
import logging
import re

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.user import User
from app.services.photo_appendix_pdf_service import (
    PhotoAppendixContext,
    PhotoAppendixPdfService,
    PhotoAppendixPhoto,
    format_photo_appendix_site_address,
)
from app.services.project_folder_service import ProjectFolderService
from app.services.project_storage_service import ProjectStorageService
from app.services.site_service import SiteService


LOGGER = logging.getLogger(__name__)
PROJECT_PHOTO_FOLDER_KEY = "fotos"
PROJECT_PHOTO_EXTENSIONS = {"gif", "heic", "heif", "jpeg", "jpg", "png", "webp"}


class ProjectPhotoPdfService:
    def __init__(
        self,
        db: Session,
        *,
        storage: ProjectStorageService | None = None,
    ) -> None:
        self.db = db
        self.storage = storage or ProjectStorageService()

    def build_site_photo_appendix(
        self,
        *,
        site_id: int,
        current_user: User,
    ) -> tuple[bytes, str]:
        site = SiteService(self.db).get_site(site_id)
        folder_service = ProjectFolderService(self.db)
        folder = folder_service.get_project_folder_for_site_by_key(
            site_id,
            PROJECT_PHOTO_FOLDER_KEY,
            current_user,
        )
        items = self.storage.list_folder_children(
            drive_id=folder.external_drive_id,
            folder_item_id=folder.external_item_id,
        )
        items = folder_service.add_document_captions(
            site_id=site_id,
            folder_key=folder.folder_key,
            items=items,
        )
        photo_items = sorted(
            (item for item in items if _is_photo_item(item)),
            key=lambda item: (
                _parse_document_datetime(item.get("created_date_time")) or datetime.min.replace(tzinfo=UTC),
                str(item.get("id") or ""),
            ),
        )
        if not photo_items:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Keine Projektfotos vorhanden.")

        appendix_photos: list[PhotoAppendixPhoto] = []
        for item in photo_items:
            item_id = str(item.get("id") or "")
            try:
                download = self.storage.download_file_from_folder(
                    drive_id=folder.external_drive_id,
                    folder_item_id=folder.external_item_id,
                    item_id=item_id,
                )
                content = bytes(download["content"])
            except (HTTPException, OSError, TypeError, ValueError) as error:
                LOGGER.warning("Project photo %s could not be downloaded for PDF: %s", item_id, error)
                content = b""
            appendix_photos.append(
                PhotoAppendixPhoto(
                    filename=str(item.get("name") or "Unbenanntes Foto"),
                    content=content,
                    caption=item.get("caption") if isinstance(item.get("caption"), str) else None,
                    uploaded_at=_parse_document_datetime(
                        item.get("created_date_time") or item.get("last_modified_date_time")
                    ),
                )
            )

        upload_times = [photo.uploaded_at for photo in appendix_photos if photo.uploaded_at]
        content = PhotoAppendixPdfService().build(
            context=PhotoAppendixContext(
                document_type="Projekt",
                site_name=site.name,
                site_number=site.site_number,
                site_address=format_photo_appendix_site_address(site),
                process_title="Projektfotos",
                generated_at=datetime.now(UTC),
                uploaded_at=max(upload_times) if upload_times else None,
            ),
            photos=appendix_photos,
        )
        filename_part = _safe_filename_part(site.site_number or site.name)
        return content, f"Fotoanlage_Projektfotos_{filename_part}.pdf"


def _is_photo_item(item: dict[str, object]) -> bool:
    if item.get("is_folder"):
        return False
    mime_type = str(item.get("mime_type") or "").casefold()
    if mime_type.startswith("image/"):
        return True
    extension = str(item.get("file_extension") or "").casefold().lstrip(".")
    return extension in PROJECT_PHOTO_EXTENSIONS


def _parse_document_datetime(value: object) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _safe_filename_part(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9ÄÖÜäöüß._-]+", "_", value.strip())
    return normalized.strip("._-") or "Baustelle"
