from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
import re
from uuid import uuid4
from zoneinfo import ZoneInfo

from fastapi import HTTPException, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from app.models.assignment import Assignment
from app.models.site import Site
from app.models.site_measurement_item import (
    SiteMeasurementBase,
    SiteMeasurementBatch,
    SiteMeasurementBatchPhoto,
    SiteMeasurementEntry,
    SiteMeasurementItem,
)
from app.models.user import User
from app.schemas.measurement import (
    CustomerSignatureCreate,
    MeasurementBaseRead,
    MeasurementBaseUpdate,
    MeasurementEntryCreate,
    MeasurementDashboardSubmissionRead,
    MeasurementEntryRead,
    MeasurementTimesheetKpiRead,
    MeasurementTimesheetRead,
    MeasurementTimesheetRowRead,
    MobileMeasurementBatchRead,
    MobileMeasurementBatchPhotoRead,
    MobileMeasurementItemRead,
    WorkerSignatureCreate,
)
from app.services.measurement_timesheet_parser import (
    MeasurementTimesheetParseError,
    parse_measurement_timesheet_pdf,
)
from app.services.project_folder_service import ProjectFolderService
from app.services.project_storage_service import ProjectStorageService


MEASUREMENT_PHOTO_FOLDER_KEY = "fotos"
MEASUREMENT_ARCHIVE_FOLDER_KEY = "aufmass"
MEASUREMENT_ARCHIVE_TIMEZONE = ZoneInfo("Europe/Berlin")
MEASUREMENT_PHOTO_CONTENT_TYPES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/heic": ".heic",
    "image/heif": ".heif",
}


class MeasurementService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def list_measurement_bases(self, site_id: int) -> list[MeasurementBaseRead]:
        self._get_site(site_id)
        bases = list(
            self.db.scalars(
                select(SiteMeasurementBase)
                .where(SiteMeasurementBase.site_id == site_id)
                .order_by(SiteMeasurementBase.created_at.desc(), SiteMeasurementBase.id.desc())
            ).all()
        )
        return [self._build_measurement_base(base) for base in bases]

    def update_measurement_base(
        self, *, site_id: int, measurement_base_id: int, payload: MeasurementBaseUpdate
    ) -> MeasurementBaseRead:
        base = self._get_measurement_base_for_site(measurement_base_id, site_id)
        if payload.name is not None:
            base.name = payload.name.strip()
        if payload.status is not None:
            base.status = payload.status
            base.closed_at = datetime.now(timezone.utc) if payload.status in {"closed", "archived"} else None
            if payload.status != "active":
                base.released_to_mobile = False
        if payload.released_to_mobile is not None:
            base.released_to_mobile = payload.released_to_mobile
        if base.status == "active" and base.released_to_mobile:
            self._activate_measurement_base(base)
        if payload.source_note is not None:
            base.source_note = payload.source_note.strip() or None
        if payload.import_label is not None:
            base.import_label = payload.import_label.strip() or None
        self.db.commit()
        self.db.refresh(base)
        return self._build_measurement_base(base)

    def activate_measurement_base(self, *, site_id: int, measurement_base_id: int) -> list[MeasurementBaseRead]:
        base = self._get_measurement_base_for_site(measurement_base_id, site_id)
        self._activate_measurement_base(base)
        self.db.commit()
        return self.list_measurement_bases(site_id)

    def delete_measurement_base(self, *, site_id: int, measurement_base_id: int) -> list[MeasurementBaseRead]:
        base = self._get_measurement_base_for_site(measurement_base_id, site_id)
        if base.status == "active" or base.released_to_mobile:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Aktive Aufmaßblätter können nicht gelöscht werden. Bitte zuerst ein anderes Aufmaßblatt aktivieren.",
            )
        batch_count = self.db.scalar(
            select(func.count(SiteMeasurementBatch.id)).where(
                SiteMeasurementBatch.site_id == site_id,
                SiteMeasurementBatch.measurement_base_id == base.id,
            )
        ) or 0
        if batch_count > 0:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Dieses Aufmaßblatt enthält bereits Aufmaßpakete oder Mengenmeldungen und kann nicht gelöscht werden.",
            )
        self.db.delete(base)
        self.db.commit()
        return self.list_measurement_bases(site_id)

    def list_items(
        self,
        site_id: int,
        measurement_base_id: int | None = None,
        active_only: bool = False,
    ) -> list[SiteMeasurementItem]:
        self._get_site(site_id)
        if active_only:
            measurement_base_id = self._get_active_measurement_base_id(site_id)
            if measurement_base_id is None:
                return []
        statement = (
            select(SiteMeasurementItem)
            .options(selectinload(SiteMeasurementItem.measurement_base))
            .where(SiteMeasurementItem.site_id == site_id)
        )
        if measurement_base_id is not None:
            statement = statement.where(SiteMeasurementItem.measurement_base_id == measurement_base_id)
        return list(
            self.db.scalars(
                statement.order_by(
                    SiteMeasurementItem.measurement_base_id,
                    SiteMeasurementItem.sort_order,
                    SiteMeasurementItem.id,
                )
            ).all()
        )

    def list_mobile_batches(
        self, *, assignment_id: int, current_user: User
    ) -> list[MobileMeasurementBatchRead]:
        assignment = self._get_user_assignment(assignment_id, current_user)
        batches = list(
            self.db.scalars(
                select(SiteMeasurementBatch)
                .options(
                    selectinload(SiteMeasurementBatch.entries).selectinload(
                        SiteMeasurementEntry.measurement_item
                    ),
                    selectinload(SiteMeasurementBatch.measurement_base),
                    selectinload(SiteMeasurementBatch.submitted_by).selectinload(User.person),
                )
                .where(SiteMeasurementBatch.site_id == assignment.site_id)
                .order_by(
                    SiteMeasurementBatch.created_at.desc(),
                    SiteMeasurementBatch.id.desc(),
                )
            ).all()
        )
        active_base_id = self._get_active_measurement_base_id(assignment.site_id)
        return [self._build_mobile_batch(batch, active_base_id=active_base_id) for batch in batches]

    def create_mobile_batch(
        self, *, assignment_id: int, current_user: User
    ) -> MobileMeasurementBatchRead:
        assignment = self._get_user_assignment(assignment_id, current_user)
        measurement_base = self._get_mobile_measurement_base_for_site(assignment.site_id)
        next_number = (
            self.db.scalar(
                select(func.max(SiteMeasurementBatch.number)).where(
                    SiteMeasurementBatch.site_id == assignment.site_id
                )
            )
            or 0
        ) + 1
        batch = SiteMeasurementBatch(
            site_id=assignment.site_id,
            measurement_base_id=measurement_base.id,
            number=next_number,
            title=f"Aufmaß {next_number}",
            status="draft",
            created_by_user_id=current_user.id,
        )
        self.db.add(batch)
        self.db.commit()
        self.db.refresh(batch)
        return self._build_mobile_batch(batch, active_base_id=measurement_base.id)

    def list_mobile_batch_items(
        self, *, assignment_id: int, batch_id: int, current_user: User
    ) -> list[MobileMeasurementItemRead]:
        assignment = self._get_user_assignment(assignment_id, current_user)
        batch = self._get_batch_for_site(batch_id, assignment.site_id)
        items = list(
            self.db.scalars(
                select(SiteMeasurementItem)
                .options(
                    selectinload(SiteMeasurementItem.entries).selectinload(
                        SiteMeasurementEntry.created_by
                    )
                )
                .where(
                    SiteMeasurementItem.site_id == batch.site_id,
                    SiteMeasurementItem.measurement_base_id == batch.measurement_base_id,
                )
                .order_by(SiteMeasurementItem.sort_order, SiteMeasurementItem.id)
            ).all()
        )
        return [self._build_mobile_item(item, batch.id) for item in items]

    def create_site_entry(
        self,
        *,
        site_id: int,
        batch_id: int,
        measurement_item_id: int,
        current_user: User,
        payload: MeasurementEntryCreate,
    ) -> MeasurementEntryRead:
        self._get_site(site_id)
        batch = self._get_batch_for_site(batch_id, site_id)
        if batch.status == "draft":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Entwürfe werden mobil bearbeitet.",
            )

        item = self.db.get(SiteMeasurementItem, measurement_item_id)
        if item is None or item.site_id != site_id or item.measurement_base_id != batch.measurement_base_id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Aufmaßposition nicht gefunden.")

        comment = payload.area_or_comment.strip()
        if not comment:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Bereich oder Kommentar ist erforderlich.")

        entry = SiteMeasurementEntry(
            measurement_batch_id=batch.id,
            measurement_item_id=item.id,
            site_id=item.site_id,
            quantity=payload.quantity,
            area_or_comment=comment,
            status="saved",
            created_by_user_id=current_user.id,
        )
        self.db.add(entry)
        self.db.commit()
        self.db.refresh(entry)
        return self._build_entry(entry)

    def create_mobile_entry(
        self,
        *,
        assignment_id: int,
        batch_id: int,
        measurement_item_id: int,
        current_user: User,
        payload: MeasurementEntryCreate,
    ) -> MeasurementEntryRead:
        assignment = self._get_user_assignment(assignment_id, current_user)
        batch = self._get_batch_for_site(batch_id, assignment.site_id)
        if batch.status != "draft":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Dieses Aufmaß wurde bereits zur Prüfung gesendet.",
            )
        self._ensure_mobile_batch_can_be_edited_by_worker(batch)

        item = self.db.get(SiteMeasurementItem, measurement_item_id)
        if (
            item is None
            or item.site_id != assignment.site_id
            or item.measurement_base_id != batch.measurement_base_id
        ):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Aufmaßposition nicht gefunden.")

        comment = payload.area_or_comment.strip()
        if not comment:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Bereich oder Kommentar ist erforderlich.")

        entry = SiteMeasurementEntry(
            measurement_batch_id=batch.id,
            measurement_item_id=item.id,
            site_id=item.site_id,
            quantity=payload.quantity,
            area_or_comment=comment,
            status="saved",
            created_by_user_id=current_user.id,
        )
        self.db.add(entry)
        self.db.commit()
        self.db.refresh(entry)
        return self._build_entry(entry)

    def delete_mobile_entry(
        self, *, assignment_id: int, batch_id: int, entry_id: int, current_user: User
    ) -> None:
        assignment = self._get_user_assignment(assignment_id, current_user)
        batch = self._get_batch_for_site(batch_id, assignment.site_id)
        if batch.status != "draft":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Dieses Aufmaß wurde bereits zur Prüfung gesendet.",
            )
        self._ensure_mobile_batch_can_be_edited_by_worker(batch)

        entry = self.db.get(SiteMeasurementEntry, entry_id)
        if entry is None or entry.measurement_batch_id != batch.id or entry.site_id != assignment.site_id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Aufmaßzeile nicht gefunden.")
        if entry.created_by_user_id is not None and entry.created_by_user_id != current_user.id:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Keine Berechtigung fuer diese Aktion.")

        self.db.delete(entry)
        self.db.commit()

    def submit_mobile_batch(
        self, *, assignment_id: int, batch_id: int, current_user: User
    ) -> MobileMeasurementBatchRead:
        assignment = self._get_user_assignment(assignment_id, current_user)
        batch = self._get_batch_for_site(batch_id, assignment.site_id)
        if batch.status != "draft":
            raise HTTPException(status.HTTP_409_CONFLICT, "Dieses Aufmaß ist kein Entwurf mehr.")
        self._ensure_mobile_batch_can_be_edited_by_worker(batch)
        if not batch.entries:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Ein Aufmaß ohne Aufmaßzeilen kann nicht gesendet werden.",
            )

        for entry in batch.entries:
            entry.submitted_area_or_comment = entry.area_or_comment
            entry.submitted_quantity = entry.quantity

        submitted_at = datetime.now(timezone.utc)
        batch.status = "submitted"
        batch.submitted_by_user_id = current_user.id
        batch.submitted_at = submitted_at
        if batch.original_submitted_snapshot is None:
            batch.original_submitted_snapshot = self._build_original_submitted_snapshot(
                batch=batch,
                submitted_by=current_user,
                submitted_at=submitted_at,
            )
        self.db.commit()
        self.db.refresh(batch)
        return self._build_mobile_batch(batch)

    def sign_mobile_batch(
        self,
        *,
        assignment_id: int,
        batch_id: int,
        current_user: User,
        payload: CustomerSignatureCreate,
    ) -> MobileMeasurementBatchRead:
        assignment = self._get_user_assignment(assignment_id, current_user)
        batch = self._get_batch_for_site(batch_id, assignment.site_id)
        if batch.customer_signed_at is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Dieses Aufmaß wurde bereits vom Kunden unterschrieben.",
            )
        if batch.status in {"billed", "approved", "closed"}:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Dieses Aufmaß ist bereits abgeschlossen.",
            )
        can_sign_immediately = _can_sign_measurements_immediately(current_user)
        if batch.status == "draft" and not can_sign_immediately:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "Kundenunterschrift ist erst nach Projektleiterprüfung möglich.",
            )
        if batch.status not in {"draft", "submitted", "reviewed", "rejected"}:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Dieses Aufmaß kann in diesem Status nicht unterschrieben werden.",
            )
        if not can_sign_immediately and batch.status != "reviewed":
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "Kundenunterschrift ist erst nach Projektleiterprüfung möglich.",
            )
        if not batch.entries:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Ein Aufmaß ohne Aufmaßzeilen kann nicht unterschrieben werden.",
            )

        customer_name = " ".join(payload.customer_name.split())
        if not customer_name:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Kundenname ist erforderlich.")

        signed_at = datetime.now(timezone.utc)
        batch.customer_signature_name = customer_name
        batch.customer_signature_strokes = [
            [point.model_dump() for point in stroke]
            for stroke in payload.signature_strokes
            if len(stroke) >= 2
        ]
        batch.customer_signed_at = signed_at
        batch.customer_signed_snapshot = self._build_measurement_snapshot(
            batch=batch,
            version_label="customer_signed",
            event_at=signed_at,
        )
        batch.status = "customer_signed"
        self.db.commit()
        self.db.refresh(batch)
        return self._build_mobile_batch(batch)

    def sign_mobile_batch_worker(
        self,
        *,
        assignment_id: int,
        batch_id: int,
        current_user: User,
        payload: WorkerSignatureCreate,
    ) -> MobileMeasurementBatchRead:
        assignment = self._get_user_assignment(assignment_id, current_user)
        batch = self._get_batch_for_site(batch_id, assignment.site_id)
        if batch.customer_signed_at is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Dieses Aufmaß wurde vom Kunden unterschrieben und ist für Monteure gesperrt.",
            )
        if batch.status in {"billed", "approved", "closed"}:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Dieses Aufmaß ist bereits abgeschlossen.",
            )
        if not batch.entries:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Ein Aufmaß ohne Aufmaßzeilen kann nicht unterschrieben werden.",
            )

        worker_name = " ".join(payload.worker_name.split())
        if not worker_name:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Monteurname ist erforderlich.")

        batch.worker_signature_name = worker_name
        batch.worker_signature_strokes = [
            [point.model_dump() for point in stroke]
            for stroke in payload.signature_strokes
            if len(stroke) >= 2
        ]
        batch.worker_signed_at = datetime.now(timezone.utc)
        self.db.commit()
        self.db.refresh(batch)
        return self._build_mobile_batch(batch)

    def list_mobile_batch_photos(
        self,
        *,
        assignment_id: int,
        batch_id: int,
        current_user: User,
    ) -> list[MobileMeasurementBatchPhotoRead]:
        assignment = self._get_user_assignment(assignment_id, current_user)
        batch = self._get_batch_for_site(batch_id, assignment.site_id)
        photos = list(
            self.db.scalars(
                select(SiteMeasurementBatchPhoto)
                .options(selectinload(SiteMeasurementBatchPhoto.uploaded_by).selectinload(User.person))
                .where(SiteMeasurementBatchPhoto.measurement_batch_id == batch.id)
                .order_by(SiteMeasurementBatchPhoto.created_at, SiteMeasurementBatchPhoto.id)
            )
        )
        return [self._build_mobile_photo(photo) for photo in photos]

    def upload_mobile_batch_photo(
        self,
        *,
        assignment_id: int,
        batch_id: int,
        current_user: User,
        filename: str | None,
        content: bytes,
        content_type: str | None,
    ) -> MobileMeasurementBatchPhotoRead:
        assignment = self._get_user_assignment(assignment_id, current_user)
        batch = self._get_batch_for_site(batch_id, assignment.site_id)
        normalized_content_type = _normalize_content_type(content_type)
        if normalized_content_type not in MEASUREMENT_PHOTO_CONTENT_TYPES:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Bitte ein Foto als JPEG, PNG, WebP oder HEIC hochladen.",
            )
        if not content:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Foto ist leer.")

        folder = ProjectFolderService(self.db).get_project_folder_for_site_by_key(
            assignment.site_id,
            MEASUREMENT_PHOTO_FOLDER_KEY,
            current_user,
        )
        upload_filename = _measurement_photo_filename(
            batch=batch,
            user=current_user,
            original_filename=filename,
            content_type=normalized_content_type,
        )
        uploaded = ProjectStorageService().upload_file_to_folder(
            drive_id=folder.external_drive_id,
            folder_item_id=folder.external_item_id,
            filename=upload_filename,
            content=content,
            content_type=normalized_content_type,
        )
        item_id = uploaded.get("id")
        if not isinstance(item_id, str) or not item_id:
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Foto konnte nicht gespeichert werden.")

        photo = SiteMeasurementBatchPhoto(
            site_id=batch.site_id,
            measurement_batch_id=batch.id,
            uploaded_by_user_id=current_user.id,
            project_folder_key=MEASUREMENT_PHOTO_FOLDER_KEY,
            external_drive_id=folder.external_drive_id or "",
            external_item_id=item_id,
            external_web_url=uploaded.get("web_url"),
            filename=str(uploaded.get("name") or upload_filename),
            content_type=normalized_content_type,
            file_size_bytes=uploaded.get("size") if isinstance(uploaded.get("size"), int) else len(content),
        )
        self.db.add(photo)
        self.db.commit()
        self.db.refresh(photo)
        return self._build_mobile_photo(photo)

    def get_mobile_batch_photo_content(
        self,
        *,
        assignment_id: int,
        batch_id: int,
        photo_id: int,
        current_user: User,
    ) -> tuple[bytes, str, str]:
        assignment = self._get_user_assignment(assignment_id, current_user)
        batch = self._get_batch_for_site(batch_id, assignment.site_id)
        photo = self._get_photo_for_batch(photo_id, batch.id)
        downloaded = ProjectStorageService().download_file_from_folder(
            drive_id=photo.external_drive_id,
            folder_item_id=self._get_photo_folder_item_id(photo, current_user),
            item_id=photo.external_item_id,
        )
        return (
            downloaded["content"],
            str(downloaded.get("content_type") or photo.content_type),
            str(downloaded.get("filename") or photo.filename),
        )

    def delete_mobile_batch_photo(
        self,
        *,
        assignment_id: int,
        batch_id: int,
        photo_id: int,
        current_user: User,
    ) -> None:
        assignment = self._get_user_assignment(assignment_id, current_user)
        batch = self._get_batch_for_site(batch_id, assignment.site_id)
        photo = self._get_photo_for_batch(photo_id, batch.id)
        ProjectStorageService().delete_file_from_folder(
            drive_id=photo.external_drive_id,
            folder_item_id=self._get_photo_folder_item_id(photo, current_user),
            item_id=photo.external_item_id,
        )
        self.db.delete(photo)
        self.db.commit()

    def list_site_batches(
        self,
        site_id: int,
        measurement_base_id: int | None = None,
        active_only: bool = False,
    ) -> list[MobileMeasurementBatchRead]:
        self._get_site(site_id)
        active_base_id = self._get_active_measurement_base_id(site_id)
        if active_only:
            measurement_base_id = active_base_id
            if measurement_base_id is None:
                return []
        statement = (
            select(SiteMeasurementBatch)
            .options(
                selectinload(SiteMeasurementBatch.entries).selectinload(
                    SiteMeasurementEntry.measurement_item
                ),
                selectinload(SiteMeasurementBatch.measurement_base),
                selectinload(SiteMeasurementBatch.submitted_by).selectinload(User.person),
            )
            .where(SiteMeasurementBatch.site_id == site_id)
        )
        if measurement_base_id is not None:
            statement = statement.where(SiteMeasurementBatch.measurement_base_id == measurement_base_id)
        batches = list(
            self.db.scalars(
                statement.order_by(SiteMeasurementBatch.number, SiteMeasurementBatch.id)
            ).all()
        )
        return [self._build_mobile_batch(batch, active_base_id=active_base_id) for batch in batches]

    def list_site_batch_items(
        self, *, site_id: int, batch_id: int
    ) -> list[MobileMeasurementItemRead]:
        self._get_site(site_id)
        batch = self._get_batch_for_site(batch_id, site_id)
        items = list(
            self.db.scalars(
                select(SiteMeasurementItem)
                .options(
                    selectinload(SiteMeasurementItem.entries).selectinload(
                        SiteMeasurementEntry.created_by
                    )
                )
                .where(
                    SiteMeasurementItem.site_id == batch.site_id,
                    SiteMeasurementItem.measurement_base_id == batch.measurement_base_id,
                )
                .order_by(SiteMeasurementItem.sort_order, SiteMeasurementItem.id)
            ).all()
        )
        return [self._build_mobile_item(item, batch.id) for item in items]

    def get_site_measurement_timesheet(self, site_id: int) -> MeasurementTimesheetRead:
        self._get_site(site_id)
        active_base_id = self._get_active_measurement_base_id(site_id)
        if active_base_id is None:
            return MeasurementTimesheetRead(
                site_id=site_id,
                measurement_base_id=None,
                active_batch_ids=[],
                active_measurement_label=None,
                last_import_label=None,
                last_import_at=None,
                kpi=MeasurementTimesheetKpiRead(
                    position_count=0,
                    planned_minutes=Decimal("0"),
                    measured_minutes=Decimal("0"),
                    open_minutes=None,
                    progress_percent=None,
                    captured_count=0,
                    not_captured_count=0,
                    has_planned_basis=False,
                ),
                rows=[],
            )

        active_base = self.db.get(SiteMeasurementBase, active_base_id)
        active_batch_ids = list(
            self.db.scalars(
                select(SiteMeasurementBatch.id)
                .where(
                    SiteMeasurementBatch.site_id == site_id,
                    SiteMeasurementBatch.measurement_base_id == active_base_id,
                )
                .order_by(SiteMeasurementBatch.number, SiteMeasurementBatch.id)
            ).all()
        )

        measured_by_item_id: dict[int, Decimal] = {}
        if active_batch_ids:
            measured_rows = self.db.execute(
                select(
                    SiteMeasurementEntry.measurement_item_id,
                    func.coalesce(func.sum(SiteMeasurementEntry.quantity), Decimal("0")),
                )
                .where(
                    SiteMeasurementEntry.site_id == site_id,
                    SiteMeasurementEntry.measurement_batch_id.in_(active_batch_ids),
                )
                .group_by(SiteMeasurementEntry.measurement_item_id)
            ).all()
            measured_by_item_id = {
                int(item_id): measured_quantity or Decimal("0")
                for item_id, measured_quantity in measured_rows
            }

        items = list(
            self.db.scalars(
                select(SiteMeasurementItem)
                .where(
                    SiteMeasurementItem.site_id == site_id,
                    SiteMeasurementItem.measurement_base_id == active_base_id,
                )
                .order_by(SiteMeasurementItem.sort_order, SiteMeasurementItem.id)
            ).all()
        )

        rows: list[MeasurementTimesheetRowRead] = []
        planned_minutes_total = Decimal("0")
        measured_minutes_total = Decimal("0")
        captured_count = 0
        latest_import_item: SiteMeasurementItem | None = None
        latest_import_timestamp: datetime | None = None

        for item in items:
            planned_quantity = item.list_quantity or Decimal("0")
            minutes_per_unit = item.minutes_per_unit or Decimal("0")
            planned_minutes = (
                planned_quantity * minutes_per_unit
                if planned_quantity > 0 and minutes_per_unit > 0
                else Decimal("0")
            )
            measured_quantity = measured_by_item_id.get(item.id, Decimal("0"))
            measured_minutes = (
                measured_quantity * minutes_per_unit
                if measured_quantity > 0 and minutes_per_unit > 0
                else Decimal("0")
            )
            remaining_quantity = planned_quantity - measured_quantity if planned_quantity > 0 else None
            progress_percent = (
                float((measured_minutes / planned_minutes) * Decimal("100"))
                if planned_minutes > 0
                else None
            )
            is_captured = measured_quantity > 0

            if is_captured:
                captured_count += 1
            planned_minutes_total += planned_minutes
            measured_minutes_total += measured_minutes

            item_timestamp = item.updated_at or item.created_at
            if (
                item_timestamp is not None
                and (latest_import_timestamp is None or item_timestamp > latest_import_timestamp)
            ):
                latest_import_item = item
                latest_import_timestamp = item_timestamp

            rows.append(
                MeasurementTimesheetRowRead(
                    position_id=item.id,
                    position_number=item.position,
                    description=item.description,
                    unit=item.unit,
                    target_quantity=item.list_quantity,
                    measured_quantity=measured_quantity,
                    remaining_quantity=remaining_quantity,
                    minutes_per_unit=item.minutes_per_unit,
                    planned_minutes=planned_minutes,
                    measured_minutes=measured_minutes,
                    progress_percent=progress_percent,
                    is_captured=is_captured,
                    search_text=f"{item.position} {item.description or ''}".lower(),
                )
            )

        has_planned_basis = planned_minutes_total > 0
        return MeasurementTimesheetRead(
            site_id=site_id,
            measurement_base_id=active_base_id,
            active_batch_ids=active_batch_ids,
            active_measurement_label=active_base.name if active_base else None,
            last_import_label=latest_import_item.source_file_name if latest_import_item else None,
            last_import_at=latest_import_timestamp,
            kpi=MeasurementTimesheetKpiRead(
                position_count=len(rows),
                planned_minutes=planned_minutes_total,
                measured_minutes=measured_minutes_total,
                open_minutes=planned_minutes_total - measured_minutes_total if has_planned_basis else None,
                progress_percent=(
                    float((measured_minutes_total / planned_minutes_total) * Decimal("100"))
                    if has_planned_basis
                    else None
                ),
                captured_count=captured_count,
                not_captured_count=len(rows) - captured_count,
                has_planned_basis=has_planned_basis,
            ),
            rows=rows,
        )

    def set_site_batch_billing_status(
        self,
        *,
        site_id: int,
        batch_id: int,
        billing_status: str,
        current_user: User | None = None,
    ) -> MobileMeasurementBatchRead:
        normalized_status = {
            "open": "submitted",
            "noch_offen": "submitted",
            "rejected": "submitted",
            "approved": "billed",
            "abgerechnet": "billed",
        }.get(billing_status, billing_status)
        if normalized_status not in {"submitted", "billed"}:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Ungültiger Abschlussstatus.")

        self._get_site(site_id)
        batch = self._get_batch_for_site(batch_id, site_id)
        if batch.status == "draft":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Entwürfe können noch nicht abgeschlossen werden.",
            )
        if normalized_status == "billed" and not (
            batch.status == "reviewed"
            or batch.status == "customer_signed"
            or batch.customer_signed_at is not None
        ):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Aufmaße müssen vor dem Abschluss durch den Projektleiter geprüft werden.",
            )

        batch.status = normalized_status
        for entry in batch.entries:
            entry.status = normalized_status
        if normalized_status == "billed" and current_user is not None:
            self._archive_billed_batch_pdf(batch=batch, current_user=current_user)
        self.db.commit()
        self.db.refresh(batch)
        return self._build_mobile_batch(batch)

    def set_site_batch_reviewed(
        self, *, site_id: int, batch_id: int
    ) -> MobileMeasurementBatchRead:
        self._get_site(site_id)
        batch = self._get_batch_for_site(batch_id, site_id)
        if batch.status == "draft":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Entwürfe müssen zuerst zur Prüfung gesendet werden.",
            )
        if batch.status in {"billed", "approved", "closed"}:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Dieses Aufmaß ist bereits abgeschlossen.",
            )
        if batch.customer_signed_at is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Unterschriebene Aufmaße bleiben bis zum Abschluss in der Prüfung.",
            )

        batch.status = "reviewed"
        for entry in batch.entries:
            entry.status = "reviewed"
        self.db.commit()
        self.db.refresh(batch)
        return self._build_mobile_batch(batch)

    def update_site_entry(
        self,
        *,
        site_id: int,
        batch_id: int,
        entry_id: int,
        payload: MeasurementEntryCreate,
    ) -> MeasurementEntryRead:
        self._get_site(site_id)
        batch = self._get_batch_for_site(batch_id, site_id)
        if batch.status == "draft":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Entwürfe werden mobil bearbeitet.",
            )

        entry = self.db.get(SiteMeasurementEntry, entry_id)
        if (
            entry is None
            or entry.site_id != site_id
            or entry.measurement_batch_id != batch.id
        ):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Aufmaßzeile nicht gefunden.")

        comment = payload.area_or_comment.strip()
        if not comment:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Bereich oder Kommentar ist erforderlich.")

        entry.area_or_comment = comment
        entry.quantity = payload.quantity
        self.db.commit()
        self.db.refresh(entry)
        return self._build_entry(entry)

    def reset_site_batch_to_submitted(
        self, *, site_id: int, batch_id: int
    ) -> list[MobileMeasurementItemRead]:
        self._get_site(site_id)
        batch = self._get_batch_for_site(batch_id, site_id)
        if batch.status == "draft":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Entwürfe haben noch keinen gespeicherten Monteurstand.",
            )
        if batch.customer_signed_at is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Unterschriebene Aufmaße behalten die unterschriebene Fassung als Grundlage.",
            )

        entries = list(batch.entries)
        if not entries:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Dieses Aufmaß enthält keine Aufmaßzeilen.",
            )

        original_entries: list[SiteMeasurementEntry] = []
        review_only_entries: list[SiteMeasurementEntry] = []
        has_partial_snapshot = False
        for entry in entries:
            has_submitted_area = entry.submitted_area_or_comment is not None
            has_submitted_quantity = entry.submitted_quantity is not None
            if has_submitted_area and has_submitted_quantity:
                original_entries.append(entry)
            elif not has_submitted_area and not has_submitted_quantity:
                review_only_entries.append(entry)
            else:
                has_partial_snapshot = True

        if has_partial_snapshot or not original_entries:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Der ursprüngliche Monteurstand ist für dieses Aufmaß nicht gespeichert.",
            )

        for entry in review_only_entries:
            self.db.delete(entry)
        for entry in original_entries:
            if entry.submitted_area_or_comment is not None:
                entry.area_or_comment = entry.submitted_area_or_comment
            if entry.submitted_quantity is not None:
                entry.quantity = entry.submitted_quantity

        self.db.commit()
        return self.list_site_batch_items(site_id=site_id, batch_id=batch_id)

    def list_dashboard_submissions(
        self, *, limit: int = 6
    ) -> list[MeasurementDashboardSubmissionRead]:
        batches = list(
            self.db.scalars(
                select(SiteMeasurementBatch)
                .options(
                    selectinload(SiteMeasurementBatch.site),
                    selectinload(SiteMeasurementBatch.entries),
                    selectinload(SiteMeasurementBatch.submitted_by).selectinload(User.person),
                )
                .where(
                    SiteMeasurementBatch.status.notin_(("billed", "approved", "closed")),
                    or_(
                        SiteMeasurementBatch.status.in_(("submitted", "rejected")),
                        SiteMeasurementBatch.customer_signed_at.is_not(None),
                    ),
                )
                .order_by(
                    func.coalesce(
                        SiteMeasurementBatch.customer_signed_at,
                        SiteMeasurementBatch.submitted_at,
                        SiteMeasurementBatch.updated_at,
                    ).desc(),
                    SiteMeasurementBatch.updated_at.desc(),
                )
                .limit(limit)
            ).all()
        )
        return [self._build_dashboard_submission(batch) for batch in batches]

    def import_timesheet(
        self,
        site_id: int,
        *,
        file_name: str | None,
        pdf_content: bytes,
        import_mode: str = "existing",
        measurement_base_id: int | None = None,
        measurement_base_name: str | None = None,
    ) -> tuple[dict, list[SiteMeasurementItem]]:
        self._get_site(site_id)
        try:
            parsed = parse_measurement_timesheet_pdf(pdf_content)
        except MeasurementTimesheetParseError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

        measurement_base = self._resolve_import_measurement_base(
            site_id=site_id,
            import_mode=import_mode,
            measurement_base_id=measurement_base_id,
            measurement_base_name=measurement_base_name,
            source_project_number=parsed.source_project_number,
            source_invoice_number=parsed.source_invoice_number,
        )

        if parsed.source_invoice_number and self._invoice_already_imported(
            site_id, parsed.source_invoice_number, measurement_base.id
        ):
            raise HTTPException(status.HTTP_409_CONFLICT, "Zeitenliste wurde für dieses Aufmaßblatt bereits importiert.")

        duplicate_position = self._find_duplicate_position_in_base(
            site_id=site_id,
            measurement_base_id=measurement_base.id,
            positions=[item.position for item in parsed.items],
        )
        if duplicate_position is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"Position {duplicate_position} existiert bereits in diesem Aufmaßblatt. Bitte ein neues Aufmaßblatt erstellen oder das bestehende prüfen.",
            )

        sort_offset = (
            self.db.scalar(
                select(func.max(SiteMeasurementItem.sort_order)).where(
                    SiteMeasurementItem.site_id == site_id,
                    SiteMeasurementItem.measurement_base_id == measurement_base.id,
                )
            )
            or 0
        )
        items = [
            SiteMeasurementItem(
                site_id=site_id,
                measurement_base_id=measurement_base.id,
                source_file_name=file_name,
                source_project_number=parsed.source_project_number,
                source_invoice_number=parsed.source_invoice_number,
                source_customer_name=parsed.source_customer_name,
                position=item.position,
                description=item.description,
                list_quantity=item.list_quantity,
                unit=item.unit,
                minutes_per_unit=item.minutes_per_unit,
                list_minutes_total=item.list_minutes_total,
                is_nep=item.is_nep,
                sort_order=sort_offset + item.sort_order,
            )
            for item in parsed.items
        ]
        self.db.add_all(items)
        self.db.commit()
        for item in items:
            self.db.refresh(item)

        summary = {
            "imported_count": len(items),
            "source_project_number": parsed.source_project_number,
            "source_invoice_number": parsed.source_invoice_number,
            "source_customer_name": parsed.source_customer_name,
            "measurement_base": self._build_measurement_base(measurement_base),
        }
        return summary, items

    def _resolve_import_measurement_base(
        self,
        *,
        site_id: int,
        import_mode: str,
        measurement_base_id: int | None,
        measurement_base_name: str | None,
        source_project_number: str | None,
        source_invoice_number: str | None,
    ) -> SiteMeasurementBase:
        normalized_mode = {
            "append_existing": "existing",
            "create_new": "new",
            "existing": "existing",
            "new": "new",
            "draft": "draft",
        }.get(import_mode, "existing")
        if normalized_mode == "existing":
            if measurement_base_id is not None:
                base = self._get_measurement_base_for_site(measurement_base_id, site_id)
                if base.status in {"closed", "archived"}:
                    raise HTTPException(
                        status.HTTP_409_CONFLICT,
                        "Geschlossene oder archivierte Aufmaßblätter können nicht erweitert werden.",
                    )
                return base
            return self._get_or_create_default_measurement_base(site_id)

        name = (measurement_base_name or "").strip()
        if not name:
            if normalized_mode == "draft":
                name = f"Aufmaßblatt Prüfung {date.today().isoformat()}"
            else:
                name = f"Aufmaßblatt {date.today().isoformat()}"
        base = SiteMeasurementBase(
            site_id=site_id,
            name=name,
            base_type="main_offer" if normalized_mode == "new" else "work_phase",
            status="draft" if normalized_mode == "draft" else "active",
            released_to_mobile=normalized_mode == "new",
            source_note=source_project_number,
            import_label=source_invoice_number,
        )
        self.db.add(base)
        self.db.flush()
        if normalized_mode == "new":
            self._activate_measurement_base(base)
        return base

    def _activate_measurement_base(self, active_base: SiteMeasurementBase) -> None:
        other_bases = list(
            self.db.scalars(
                select(SiteMeasurementBase).where(
                    SiteMeasurementBase.site_id == active_base.site_id,
                    SiteMeasurementBase.id != active_base.id,
                )
            ).all()
        )
        for base in other_bases:
            base.released_to_mobile = False
            if base.status == "active":
                base.status = "draft"
                base.closed_at = None
        active_base.status = "active"
        active_base.released_to_mobile = True
        active_base.closed_at = None

    def _get_or_create_default_measurement_base(self, site_id: int) -> SiteMeasurementBase:
        base = self.db.scalar(
            select(SiteMeasurementBase)
            .where(
                SiteMeasurementBase.site_id == site_id,
                SiteMeasurementBase.status.notin_(("closed", "archived")),
            )
            .order_by(SiteMeasurementBase.created_at.desc(), SiteMeasurementBase.id.desc())
        )
        if base is not None:
            return base
        base = SiteMeasurementBase(
            site_id=site_id,
            name="Aufmaßblatt Bestand",
            base_type="mixed",
            status="active",
            released_to_mobile=True,
        )
        self.db.add(base)
        self.db.flush()
        return base

    def _get_mobile_measurement_base_for_site(self, site_id: int) -> SiteMeasurementBase:
        base = self.db.scalar(
            select(SiteMeasurementBase)
            .where(
                SiteMeasurementBase.site_id == site_id,
                SiteMeasurementBase.status == "active",
                SiteMeasurementBase.released_to_mobile.is_(True),
            )
            .order_by(SiteMeasurementBase.created_at.desc(), SiteMeasurementBase.id.desc())
        )
        if base is None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Für diese Baustelle ist kein aktives Aufmaßblatt für Monteure freigegeben.",
            )
        return base

    def _get_active_measurement_base_id(self, site_id: int) -> int | None:
        return self.db.scalar(
            select(SiteMeasurementBase.id)
            .where(
                SiteMeasurementBase.site_id == site_id,
                SiteMeasurementBase.status == "active",
                SiteMeasurementBase.released_to_mobile.is_(True),
            )
            .order_by(SiteMeasurementBase.created_at.desc(), SiteMeasurementBase.id.desc())
        )

    def _get_measurement_base_for_site(self, measurement_base_id: int, site_id: int) -> SiteMeasurementBase:
        base = self.db.scalar(
            select(SiteMeasurementBase).where(
                SiteMeasurementBase.id == measurement_base_id,
                SiteMeasurementBase.site_id == site_id,
            )
        )
        if base is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Aufmaßblatt nicht gefunden.")
        return base

    def _find_duplicate_position_in_base(
        self, *, site_id: int, measurement_base_id: int, positions: list[str]
    ) -> str | None:
        if not positions:
            return None
        existing = self.db.scalar(
            select(SiteMeasurementItem.position)
            .where(
                SiteMeasurementItem.site_id == site_id,
                SiteMeasurementItem.measurement_base_id == measurement_base_id,
                SiteMeasurementItem.position.in_(positions),
            )
            .limit(1)
        )
        return existing

    def _get_user_assignment(self, assignment_id: int, current_user: User) -> Assignment:
        if current_user.person_id is None:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Dieser Benutzer ist keiner Person zugeordnet.",
            )
        assignment = self.db.scalar(
            select(Assignment).where(
                Assignment.id == assignment_id,
                Assignment.person_id == current_user.person_id,
            )
        )
        if assignment is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Einsatz nicht gefunden.")
        return assignment

    def _get_batch_for_site(self, batch_id: int, site_id: int) -> SiteMeasurementBatch:
        batch = self.db.scalar(
            select(SiteMeasurementBatch)
            .options(
                selectinload(SiteMeasurementBatch.entries).selectinload(
                    SiteMeasurementEntry.measurement_item
                ),
                selectinload(SiteMeasurementBatch.submitted_by).selectinload(User.person),
            )
            .where(SiteMeasurementBatch.id == batch_id, SiteMeasurementBatch.site_id == site_id)
        )
        if batch is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Aufmaß nicht gefunden.")
        return batch

    def _format_user_display_name(self, user: User | None) -> str | None:
        if user is None:
            return None
        if user.person and user.person.display_name:
            return user.person.display_name
        return user.display_name

    def _build_measurement_base(self, base: SiteMeasurementBase) -> MeasurementBaseRead:
        result = MeasurementBaseRead.model_validate(base)
        result.item_count = self.db.scalar(
            select(func.count(SiteMeasurementItem.id)).where(SiteMeasurementItem.measurement_base_id == base.id)
        ) or 0
        result.batch_count = self.db.scalar(
            select(func.count(SiteMeasurementBatch.id)).where(SiteMeasurementBatch.measurement_base_id == base.id)
        ) or 0
        return result

    def _build_mobile_batch(
        self,
        batch: SiteMeasurementBatch,
        active_base_id: int | None = None,
    ) -> MobileMeasurementBatchRead:
        position_ids = {entry.measurement_item_id for entry in batch.entries}
        reported_minutes = self._sum_reported_minutes(batch.entries)
        reported_hours = reported_minutes / Decimal("60") if reported_minutes is not None else None
        is_current_offer = (
            batch.measurement_base_id == active_base_id
            if active_base_id is not None
            else bool(
                batch.measurement_base
                and batch.measurement_base.status == "active"
                and batch.measurement_base.released_to_mobile
            )
        )
        return MobileMeasurementBatchRead(
            id=batch.id,
            site_id=batch.site_id,
            measurement_base_id=batch.measurement_base_id,
            measurement_base_name=batch.measurement_base.name if batch.measurement_base else None,
            offer_id=batch.measurement_base_id,
            offer_name=batch.measurement_base.name if batch.measurement_base else None,
            is_current_offer=is_current_offer,
            number=batch.number,
            title=batch.title,
            status=batch.status,
            created_by_user_id=batch.created_by_user_id,
            submitted_by_user_id=batch.submitted_by_user_id,
            submitted_by_name=self._format_user_display_name(batch.submitted_by),
            submitted_at=batch.submitted_at,
            customer_signed_at=batch.customer_signed_at,
            customer_signature_name=batch.customer_signature_name,
            worker_signed_at=batch.worker_signed_at,
            worker_signature_name=batch.worker_signature_name,
            is_locked_for_worker=batch.customer_signed_at is not None,
            created_at=batch.created_at,
            updated_at=batch.updated_at,
            position_count=len(position_ids),
            entry_count=len(batch.entries),
            reported_minutes=reported_minutes,
            reported_hours=reported_hours,
            photo_count=self.db.scalar(
                select(func.count(SiteMeasurementBatchPhoto.id)).where(
                    SiteMeasurementBatchPhoto.measurement_batch_id == batch.id
                )
            ) or 0,
        )

    def _build_mobile_photo(self, photo: SiteMeasurementBatchPhoto) -> MobileMeasurementBatchPhotoRead:
        return MobileMeasurementBatchPhotoRead(
            id=photo.id,
            site_id=photo.site_id,
            measurement_batch_id=photo.measurement_batch_id,
            filename=photo.filename,
            content_type=photo.content_type,
            file_size_bytes=photo.file_size_bytes,
            external_web_url=photo.external_web_url,
            uploaded_by_name=self._format_user_display_name(photo.uploaded_by),
            taken_at=photo.taken_at,
            created_at=photo.created_at,
            updated_at=photo.updated_at,
        )

    def _get_photo_for_batch(self, photo_id: int, batch_id: int) -> SiteMeasurementBatchPhoto:
        photo = self.db.scalar(
            select(SiteMeasurementBatchPhoto)
            .options(selectinload(SiteMeasurementBatchPhoto.uploaded_by).selectinload(User.person))
            .where(
                SiteMeasurementBatchPhoto.id == photo_id,
                SiteMeasurementBatchPhoto.measurement_batch_id == batch_id,
            )
        )
        if photo is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Foto nicht gefunden.")
        return photo

    def _get_photo_folder_item_id(
        self,
        photo: SiteMeasurementBatchPhoto,
        current_user: User,
    ) -> str:
        folder = ProjectFolderService(self.db).get_project_folder_for_site_by_key(
            photo.site_id,
            photo.project_folder_key,
            current_user,
        )
        if not folder.external_item_id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Fotoordner ist noch nicht angebunden.")
        return folder.external_item_id

    def _ensure_mobile_batch_can_be_edited_by_worker(self, batch: SiteMeasurementBatch) -> None:
        if batch.customer_signed_at is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Dieses Aufmaß wurde vom Kunden unterschrieben und ist für Monteure gesperrt.",
            )

    def _build_original_submitted_snapshot(
        self,
        *,
        batch: SiteMeasurementBatch,
        submitted_by: User,
        submitted_at: datetime,
    ) -> dict[str, object]:
        snapshot = self._build_measurement_snapshot(
            batch=batch,
            version_label="submitted",
            event_at=submitted_at,
        )
        snapshot.update(
            {
                "submitted_by_user_id": submitted_by.id,
                "submitted_by_name": self._format_user_display_name(submitted_by),
                "submitted_at": submitted_at.isoformat(),
            }
        )
        return snapshot

    def _build_measurement_snapshot(
        self,
        *,
        batch: SiteMeasurementBatch,
        version_label: str,
        event_at: datetime,
    ) -> dict[str, object]:
        entries: list[dict[str, object]] = []
        for entry in sorted(batch.entries, key=lambda row: (row.created_at, row.id)):
            item = entry.measurement_item
            if item is None:
                continue
            entries.append(
                {
                    "entry_id": entry.id,
                    "measurement_item_id": item.id,
                    "site_id": entry.site_id,
                    "position": item.position,
                    "description": item.description,
                    "unit": item.unit,
                    "sort_order": item.sort_order,
                    "area_or_comment": entry.area_or_comment,
                    "quantity": _decimal_as_string(entry.quantity),
                    "created_by_user_id": entry.created_by_user_id,
                    "created_at": _datetime_as_string(entry.created_at),
                }
            )

        return {
            "version": 1,
            "measurement_batch_id": batch.id,
            "site_id": batch.site_id,
            "measurement_base_id": batch.measurement_base_id,
            "number": batch.number,
            "title": batch.title,
            "version_label": version_label,
            "event_at": event_at.isoformat(),
            "entries": entries,
        }

    def _build_dashboard_submission(
        self, batch: SiteMeasurementBatch
    ) -> MeasurementDashboardSubmissionRead:
        position_ids = {entry.measurement_item_id for entry in batch.entries}
        is_customer_signed = batch.customer_signed_at is not None and batch.status not in {
            "billed",
            "approved",
            "closed",
        }
        return MeasurementDashboardSubmissionRead(
            batch_id=batch.id,
            site_id=batch.site_id,
            site_name=batch.site.name if batch.site else "Baustelle",
            site_number=batch.site.site_number if batch.site else None,
            title=batch.title,
            status=batch.status,
            message_type="measurement_customer_signed" if is_customer_signed else "measurement_submitted",
            event_at=batch.customer_signed_at if is_customer_signed else batch.submitted_at,
            submitted_by_name=self._format_user_display_name(batch.submitted_by),
            submitted_at=batch.submitted_at,
            customer_signature_name=batch.customer_signature_name,
            customer_signed_at=batch.customer_signed_at,
            entry_count=len(batch.entries),
            position_count=len(position_ids),
        )

    def _build_mobile_item(
        self, item: SiteMeasurementItem, batch_id: int
    ) -> MobileMeasurementItemRead:
        entries = sorted(
            (entry for entry in item.entries if entry.measurement_batch_id == batch_id),
            key=lambda entry: (entry.created_at, entry.id),
        )
        reported_quantity = sum((entry.quantity for entry in entries), Decimal("0"))
        reported_minutes = (
            reported_quantity * item.minutes_per_unit
            if item.minutes_per_unit is not None
            else None
        )
        reported_hours = reported_minutes / Decimal("60") if reported_minutes is not None else None
        mobile_status = "open"
        if entries:
            mobile_status = "billed" if all(entry.status in {"billed", "approved"} for entry in entries) else "edited"

        return MobileMeasurementItemRead(
            id=item.id,
            site_id=item.site_id,
            measurement_base_id=item.measurement_base_id,
            source_file_name=item.source_file_name,
            source_project_number=item.source_project_number,
            source_invoice_number=item.source_invoice_number,
            source_customer_name=item.source_customer_name,
            position=item.position,
            description=item.description,
            list_quantity=item.list_quantity,
            unit=item.unit,
            minutes_per_unit=item.minutes_per_unit,
            list_minutes_total=item.list_minutes_total,
            is_nep=item.is_nep,
            sort_order=item.sort_order,
            measurement_base=self._build_measurement_base(item.measurement_base) if item.measurement_base else None,
            created_at=item.created_at,
            updated_at=item.updated_at,
            entries=[self._build_entry(entry) for entry in entries],
            reported_quantity=reported_quantity,
            reported_minutes=reported_minutes,
            reported_hours=reported_hours,
            mobile_status=mobile_status,
        )

    def _sum_reported_minutes(
        self, entries: list[SiteMeasurementEntry]
    ) -> Decimal | None:
        total = Decimal("0")
        has_minutes = False
        for entry in entries:
            if entry.measurement_item.minutes_per_unit is None:
                continue
            total += entry.quantity * entry.measurement_item.minutes_per_unit
            has_minutes = True
        return total if has_minutes else None

    def _build_entry(self, entry: SiteMeasurementEntry) -> MeasurementEntryRead:
        return MeasurementEntryRead(
            id=entry.id,
            measurement_batch_id=entry.measurement_batch_id,
            measurement_item_id=entry.measurement_item_id,
            site_id=entry.site_id,
            quantity=entry.quantity,
            area_or_comment=entry.area_or_comment,
            status=entry.status,
            created_by_user_id=entry.created_by_user_id,
            created_by_name=entry.created_by.display_name if entry.created_by else None,
            created_at=entry.created_at,
            updated_at=entry.updated_at,
        )

    def _archive_billed_batch_pdf(self, *, batch: SiteMeasurementBatch, current_user: User) -> None:
        if batch.site is None:
            batch.site = self._get_site(batch.site_id)
        folder = ProjectFolderService(self.db).get_project_folder_for_site_by_key(
            batch.site_id,
            MEASUREMENT_ARCHIVE_FOLDER_KEY,
            current_user,
        )
        from app.services.measurement_pdf_service import MeasurementPdfService

        pdf_content, _generated_filename = MeasurementPdfService(self.db).build_batch_pdf(
            site_id=batch.site_id,
            batch_id=batch.id,
            mode="checked",
        )
        ProjectStorageService().upload_file_to_folder(
            drive_id=folder.external_drive_id,
            folder_item_id=folder.external_item_id,
            filename=_measurement_archive_filename(batch),
            content=pdf_content,
            content_type="application/pdf",
        )

    def _get_site(self, site_id: int) -> Site:
        site = self.db.get(Site, site_id)
        if site is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Baustelle nicht gefunden.")
        return site

    def _invoice_already_imported(
        self, site_id: int, invoice_number: str, measurement_base_id: int
    ) -> bool:
        return (
            self.db.scalar(
                select(SiteMeasurementItem.id)
                .where(
                    SiteMeasurementItem.site_id == site_id,
                    SiteMeasurementItem.measurement_base_id == measurement_base_id,
                    SiteMeasurementItem.source_invoice_number == invoice_number,
                )
                .limit(1)
            )
            is not None
        )


def _decimal_as_string(value: Decimal) -> str:
    return f"{value:.2f}"


def _datetime_as_string(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def _can_sign_measurements_immediately(user: User) -> bool:
    return bool(user.person and user.person.can_sign_measurements_immediately)


def _normalize_content_type(value: str | None) -> str:
    return (value or "application/octet-stream").split(";", 1)[0].strip().lower()


def _measurement_photo_filename(
    *,
    batch: SiteMeasurementBatch,
    user: User,
    original_filename: str | None,
    content_type: str,
) -> str:
    extension = MEASUREMENT_PHOTO_CONTENT_TYPES.get(content_type)
    original_extension = Path(original_filename or "").suffix.lower()
    if original_extension in {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"}:
        extension = ".jpg" if original_extension == ".jpeg" else original_extension
    extension = extension or ".jpg"
    user_label = _safe_filename_part(
        (user.person.display_name if user.person else None)
        or user.display_name
        or f"user-{user.id}"
    )
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    suffix = uuid4().hex[:8]
    return f"Aufmass-{batch.number}_{timestamp}_{user_label}_{suffix}{extension}"


def _measurement_archive_filename(
    batch: SiteMeasurementBatch,
    completed_at: datetime | None = None,
) -> str:
    completed_at = completed_at or datetime.now(MEASUREMENT_ARCHIVE_TIMEZONE)
    date_prefix = completed_at.astimezone(MEASUREMENT_ARCHIVE_TIMEZONE).strftime("%y%m%d")
    site_name = _safe_measurement_archive_filename_part(
        batch.site.name if batch.site and batch.site.name else "Projekt"
    )
    site_number = _safe_measurement_archive_filename_part(
        batch.site.site_number if batch.site and batch.site.site_number else "ohne_Nummer"
    )
    return f"{date_prefix}_Aufmaß_{site_name}_{site_number}.pdf"


def _safe_measurement_archive_filename_part(value: str) -> str:
    normalized = re.sub(r'[/\\:*?"<>|]+', "_", value.strip())
    normalized = re.sub(r"\s+", "_", normalized)
    normalized = re.sub(r"_+", "_", normalized)
    return normalized.strip("._ ") or "Projekt"


def _safe_filename_part(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9_-]+", "-", value.strip())
    return normalized.strip("-")[:48] or "foto"
