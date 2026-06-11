from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.models.assignment import Assignment
from app.models.extra_work_ticket import ExtraWorkTicket, ExtraWorkTicketEntry, ExtraWorkTicketPhoto
from app.models.site import Site
from app.models.user import User
from app.schemas.extra_work import (
    ExtraWorkCustomerSignatureCreate,
    ExtraWorkTicketCreate,
    ExtraWorkTicketEntryPayload,
    ExtraWorkTicketEntryRead,
    ExtraWorkTicketPhotoRead,
    ExtraWorkTicketRead,
)
from app.services.project_folder_service import ProjectFolderService
from app.services.project_storage_service import ProjectStorageService

EXTRA_WORK_SUBMITTABLE_STATUSES = {"draft"}
EXTRA_WORK_KINDS = {"billing", "approval"}
EXTRA_WORK_BILLING_KIND = "billing"
EXTRA_WORK_APPROVAL_KIND = "approval"
EXTRA_WORK_PHOTO_FOLDER_KEY = "fotos"
EXTRA_WORK_PHOTO_CONTENT_TYPES = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/heic": ".heic",
    "image/heif": ".heif",
}
EXTRA_WORK_CUSTOMER_SIGNATURE_TYPES = {
    EXTRA_WORK_BILLING_KIND: "billing_customer",
    EXTRA_WORK_APPROVAL_KIND: "approval_customer",
}


class ExtraWorkService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def list_site_tickets(self, site_id: int) -> list[ExtraWorkTicketRead]:
        self._get_site(site_id)
        tickets = list(
            self.db.scalars(
                select(ExtraWorkTicket)
                .where(ExtraWorkTicket.site_id == site_id)
                .order_by(ExtraWorkTicket.sequence_number, ExtraWorkTicket.id)
            ).all()
        )
        return [ExtraWorkTicketRead.model_validate(ticket) for ticket in tickets]

    def create_site_ticket(
        self,
        *,
        site_id: int,
        current_user: User,
        payload: ExtraWorkTicketCreate,
    ) -> ExtraWorkTicketRead:
        site = self._get_site(site_id)
        next_sequence = (
            self.db.scalar(
                select(func.max(ExtraWorkTicket.sequence_number)).where(
                    ExtraWorkTicket.site_id == site_id
                )
            )
            or 0
        ) + 1
        ticket = ExtraWorkTicket(
            site_id=site_id,
            sequence_number=next_sequence,
            display_number=self._build_display_number(site, next_sequence),
            title=payload.title.strip() if payload.title and payload.title.strip() else None,
            kind=self._normalize_kind(payload.kind, default=EXTRA_WORK_BILLING_KIND),
            approval_ticket_id=self._validate_approval_ticket_id(site_id, payload.approval_ticket_id),
            status="draft",
            created_by_user_id=current_user.id,
            notes=payload.notes.strip() if payload.notes and payload.notes.strip() else None,
        )
        self.db.add(ticket)
        self.db.commit()
        self.db.refresh(ticket)
        return ExtraWorkTicketRead.model_validate(ticket)

    def list_mobile_tickets(
        self,
        *,
        assignment_id: int,
        current_user: User,
    ) -> list[ExtraWorkTicketRead]:
        assignment = self._get_user_assignment(assignment_id, current_user)
        return self.list_site_tickets(assignment.site_id)

    def create_mobile_ticket(
        self,
        *,
        assignment_id: int,
        current_user: User,
        payload: ExtraWorkTicketCreate | None = None,
    ) -> ExtraWorkTicketRead:
        assignment = self._get_user_assignment(assignment_id, current_user)
        site = self._get_site(assignment.site_id)
        requested = payload or ExtraWorkTicketCreate()
        default_kind = EXTRA_WORK_APPROVAL_KIND if site.requires_extra_work_approval else EXTRA_WORK_BILLING_KIND
        return self.create_site_ticket(
            site_id=assignment.site_id,
            current_user=current_user,
            payload=ExtraWorkTicketCreate(
                title=requested.title,
                kind=requested.kind or default_kind,
                approval_ticket_id=requested.approval_ticket_id,
                notes=requested.notes,
            ),
        )

    def get_mobile_ticket(
        self,
        *,
        assignment_id: int,
        ticket_id: int,
        current_user: User,
    ) -> ExtraWorkTicketRead:
        assignment = self._get_user_assignment(assignment_id, current_user)
        ticket = self._get_ticket_for_site(ticket_id, assignment.site_id)
        return ExtraWorkTicketRead.model_validate(ticket)

    def submit_mobile_ticket(
        self,
        *,
        assignment_id: int,
        ticket_id: int,
        current_user: User,
    ) -> ExtraWorkTicketRead:
        assignment = self._get_user_assignment(assignment_id, current_user)
        ticket = self._get_ticket_for_site(ticket_id, assignment.site_id)
        if ticket.status not in EXTRA_WORK_SUBMITTABLE_STATUSES:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Stundenzettel kann nicht zur Prüfung gesendet werden.")
        ticket.status = "submitted"
        ticket.submitted_by_user_id = current_user.id
        ticket.submitted_at = datetime.now(UTC)
        self.db.add(ticket)
        self.db.commit()
        self.db.refresh(ticket)
        return ExtraWorkTicketRead.model_validate(ticket)

    def update_mobile_ticket_status(
        self,
        *,
        assignment_id: int,
        ticket_id: int,
        next_status: str,
        current_user: User,
    ) -> ExtraWorkTicketRead:
        if next_status != "submitted":
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Status wird für mobile Stundenzettel noch nicht unterstützt.")
        return self.submit_mobile_ticket(
            assignment_id=assignment_id,
            ticket_id=ticket_id,
            current_user=current_user,
        )

    def get_mobile_ticket_entry(
        self,
        *,
        assignment_id: int,
        ticket_id: int,
        current_user: User,
    ) -> ExtraWorkTicketEntryRead | None:
        assignment = self._get_user_assignment(assignment_id, current_user)
        self._get_ticket_for_site(ticket_id, assignment.site_id)
        entry = self.db.scalar(
            select(ExtraWorkTicketEntry)
            .where(ExtraWorkTicketEntry.ticket_id == ticket_id)
            .order_by(ExtraWorkTicketEntry.id)
        )
        return ExtraWorkTicketEntryRead.model_validate(entry) if entry else None

    def upsert_mobile_ticket_entry(
        self,
        *,
        assignment_id: int,
        ticket_id: int,
        current_user: User,
        payload: ExtraWorkTicketEntryPayload,
    ) -> ExtraWorkTicketEntryRead:
        assignment = self._get_user_assignment(assignment_id, current_user)
        ticket = self._get_ticket_for_site(ticket_id, assignment.site_id)
        if ticket.status != "draft":
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Eingaben können nur im Entwurf geändert werden.")
        entry = self.db.scalar(
            select(ExtraWorkTicketEntry)
            .where(ExtraWorkTicketEntry.ticket_id == ticket.id)
            .order_by(ExtraWorkTicketEntry.id)
        )
        worker_rows = [row.model_dump() for row in payload.worker_rows]
        values = {
            "site_id": ticket.site_id,
            "component": payload.component.strip(),
            "floor": payload.floor.strip(),
            "room_number": self._clean_optional_text(payload.room_number),
            "axis": self._clean_optional_text(payload.axis),
            "remarks": self._clean_optional_text(payload.remarks),
            "material_text": self._clean_optional_text(payload.material_text),
            "estimated_hours": payload.estimated_hours,
            "worker_rows": worker_rows,
        }
        if entry is None:
            entry = ExtraWorkTicketEntry(
                ticket_id=ticket.id,
                created_by_user_id=current_user.id,
                **values,
            )
        else:
            for key, value in values.items():
                setattr(entry, key, value)
        self.db.add(entry)
        self.db.commit()
        self.db.refresh(entry)
        return ExtraWorkTicketEntryRead.model_validate(entry)

    def sign_mobile_ticket_customer(
        self,
        *,
        assignment_id: int,
        ticket_id: int,
        current_user: User,
        payload: ExtraWorkCustomerSignatureCreate,
    ) -> ExtraWorkTicketRead:
        assignment = self._get_user_assignment(assignment_id, current_user)
        ticket = self._get_ticket_for_site(ticket_id, assignment.site_id)
        if ticket.customer_signed_at is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Dieser Stundenzettel wurde bereits vom Kunden unterschrieben.",
            )
        if ticket.status in {"billed", "closed"}:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Dieser Stundenzettel ist bereits abgeschlossen.",
            )
        customer_name = " ".join(payload.customer_name.split())
        if not customer_name:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Kundenname ist erforderlich.")
        valid_strokes = [stroke for stroke in payload.signature_strokes if len(stroke) >= 2]
        if not valid_strokes:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unterschrift ist erforderlich.")

        ticket.customer_signature_type = EXTRA_WORK_CUSTOMER_SIGNATURE_TYPES.get(
            ticket.kind, "billing_customer"
        )
        ticket.customer_signature_name = customer_name
        ticket.customer_signature_place = self._clean_optional_text(payload.customer_place)
        ticket.customer_signature_strokes = [
            [point.model_dump() for point in stroke]
            for stroke in valid_strokes
        ]
        ticket.customer_signed_at = datetime.now(UTC)
        ticket.status = "signed"
        self.db.add(ticket)
        self.db.commit()
        self.db.refresh(ticket)
        return ExtraWorkTicketRead.model_validate(ticket)

    def list_mobile_ticket_photos(
        self,
        *,
        assignment_id: int,
        ticket_id: int,
        current_user: User,
    ) -> list[ExtraWorkTicketPhotoRead]:
        assignment = self._get_user_assignment(assignment_id, current_user)
        ticket = self._get_ticket_for_site(ticket_id, assignment.site_id)
        photos = list(
            self.db.scalars(
                select(ExtraWorkTicketPhoto)
                .options(selectinload(ExtraWorkTicketPhoto.uploaded_by).selectinload(User.person))
                .where(ExtraWorkTicketPhoto.extra_work_ticket_id == ticket.id)
                .order_by(ExtraWorkTicketPhoto.created_at, ExtraWorkTicketPhoto.id)
            )
        )
        return [self._build_mobile_photo(photo) for photo in photos]

    def upload_mobile_ticket_photo(
        self,
        *,
        assignment_id: int,
        ticket_id: int,
        current_user: User,
        filename: str | None,
        content: bytes,
        content_type: str | None,
    ) -> ExtraWorkTicketPhotoRead:
        assignment = self._get_user_assignment(assignment_id, current_user)
        ticket = self._get_ticket_for_site(ticket_id, assignment.site_id)
        normalized_content_type = _normalize_content_type(content_type)
        if normalized_content_type not in EXTRA_WORK_PHOTO_CONTENT_TYPES:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Bitte ein Foto als JPEG, PNG, WebP oder HEIC hochladen.",
            )
        if not content:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Foto ist leer.")

        folder = ProjectFolderService(self.db).get_project_folder_for_site_by_key(
            assignment.site_id,
            EXTRA_WORK_PHOTO_FOLDER_KEY,
            current_user,
        )
        upload_filename = _extra_work_photo_filename(
            ticket=ticket,
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

        photo = ExtraWorkTicketPhoto(
            site_id=ticket.site_id,
            extra_work_ticket_id=ticket.id,
            uploaded_by_user_id=current_user.id,
            project_folder_key=EXTRA_WORK_PHOTO_FOLDER_KEY,
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

    def get_mobile_ticket_photo_content(
        self,
        *,
        assignment_id: int,
        ticket_id: int,
        photo_id: int,
        current_user: User,
    ) -> tuple[bytes, str, str]:
        assignment = self._get_user_assignment(assignment_id, current_user)
        ticket = self._get_ticket_for_site(ticket_id, assignment.site_id)
        photo = self._get_photo_for_ticket(photo_id, ticket.id)
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

    def delete_mobile_ticket_photo(
        self,
        *,
        assignment_id: int,
        ticket_id: int,
        photo_id: int,
        current_user: User,
    ) -> None:
        assignment = self._get_user_assignment(assignment_id, current_user)
        ticket = self._get_ticket_for_site(ticket_id, assignment.site_id)
        photo = self._get_photo_for_ticket(photo_id, ticket.id)
        ProjectStorageService().delete_file_from_folder(
            drive_id=photo.external_drive_id,
            folder_item_id=self._get_photo_folder_item_id(photo, current_user),
            item_id=photo.external_item_id,
        )
        self.db.delete(photo)
        self.db.commit()

    def _get_site(self, site_id: int) -> Site:
        site = self.db.get(Site, site_id)
        if site is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Baustelle nicht gefunden.")
        return site

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

    def _get_ticket_for_site(self, ticket_id: int, site_id: int) -> ExtraWorkTicket:
        ticket = self.db.scalar(
            select(ExtraWorkTicket).where(
                ExtraWorkTicket.id == ticket_id,
                ExtraWorkTicket.site_id == site_id,
            )
        )
        if ticket is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Stundenzettel nicht gefunden.")
        return ticket

    def _build_mobile_photo(self, photo: ExtraWorkTicketPhoto) -> ExtraWorkTicketPhotoRead:
        return ExtraWorkTicketPhotoRead(
            id=photo.id,
            site_id=photo.site_id,
            extra_work_ticket_id=photo.extra_work_ticket_id,
            filename=photo.filename,
            content_type=photo.content_type,
            file_size_bytes=photo.file_size_bytes,
            external_web_url=photo.external_web_url,
            uploaded_by_name=self._format_user_display_name(photo.uploaded_by),
            taken_at=photo.taken_at,
            created_at=photo.created_at,
            updated_at=photo.updated_at,
        )

    def _get_photo_for_ticket(self, photo_id: int, ticket_id: int) -> ExtraWorkTicketPhoto:
        photo = self.db.scalar(
            select(ExtraWorkTicketPhoto)
            .options(selectinload(ExtraWorkTicketPhoto.uploaded_by).selectinload(User.person))
            .where(
                ExtraWorkTicketPhoto.id == photo_id,
                ExtraWorkTicketPhoto.extra_work_ticket_id == ticket_id,
            )
        )
        if photo is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Foto nicht gefunden.")
        return photo

    def _get_photo_folder_item_id(
        self,
        photo: ExtraWorkTicketPhoto,
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

    @staticmethod
    def _format_user_display_name(user: User | None) -> str | None:
        if user is None:
            return None
        if user.person and user.person.display_name:
            return user.person.display_name
        return user.display_name or user.username

    def _validate_approval_ticket_id(self, site_id: int, approval_ticket_id: int | None) -> int | None:
        if approval_ticket_id is None:
            return None
        approval_ticket = self._get_ticket_for_site(approval_ticket_id, site_id)
        if approval_ticket.kind != EXTRA_WORK_APPROVAL_KIND:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Verknüpfte Freigabe muss eine Stundenfreigabe sein.")
        return approval_ticket.id

    @staticmethod
    def _normalize_kind(value: str | None, *, default: str) -> str:
        normalized = value.strip().lower() if isinstance(value, str) else ""
        kind = normalized or default
        if kind not in EXTRA_WORK_KINDS:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unbekannte Stundenzettel-Prozessart.")
        return kind

    @staticmethod
    def _clean_optional_text(value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None

    @staticmethod
    def _build_display_number(site: Site, sequence_number: int) -> str:
        clean_site_number = site.site_number.strip() if site.site_number else ""
        if clean_site_number:
            return f"{clean_site_number}.SZ{sequence_number:02d}"
        return f"Stundenzettel {sequence_number}"


def _normalize_content_type(value: str | None) -> str:
    return (value or "application/octet-stream").split(";", 1)[0].strip().lower()


def _extra_work_photo_filename(
    *,
    ticket: ExtraWorkTicket,
    user: User,
    original_filename: str | None,
    content_type: str,
) -> str:
    extension = EXTRA_WORK_PHOTO_CONTENT_TYPES.get(content_type)
    original_extension = Path(original_filename or "").suffix.lower()
    if original_extension in {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"}:
        extension = ".jpg" if original_extension == ".jpeg" else original_extension
    extension = extension or ".jpg"
    user_label = _safe_filename_part(
        (user.person.display_name if user.person else None)
        or user.display_name
        or f"user-{user.id}"
    )
    ticket_label = _safe_filename_part(ticket.display_number or f"stundenzettel-{ticket.id}")
    timestamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    suffix = uuid4().hex[:8]
    return f"Stundenzettel-{ticket_label}_{timestamp}_{user_label}_{suffix}{extension}"


def _safe_filename_part(value: str | None) -> str:
    cleaned = "".join(char if char.isalnum() else "-" for char in (value or "").strip())
    cleaned = "-".join(part for part in cleaned.split("-") if part)
    return cleaned[:80] or "unbekannt"
