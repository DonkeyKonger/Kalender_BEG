from collections import Counter
from datetime import UTC, datetime
from hashlib import sha256
import logging
from collections.abc import Callable

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.models.audit_log import AuditLog
from app.models.assignment import Assignment
from app.models.extra_work_ticket import ExtraWorkTicket, ExtraWorkTicketEntry, ExtraWorkTicketPhoto
from app.models.person import Person
from app.models.site import Site
from app.models.user import User
from app.schemas.extra_work import (
    ExtraWorkCustomerSignatureCreate,
    ExtraWorkTicketCreate,
    ExtraWorkTicketDocumentCustomerSignatureRead,
    ExtraWorkTicketDocumentDatesRead,
    ExtraWorkTicketDocumentRead,
    ExtraWorkTicketDocumentUpdate,
    ExtraWorkTicketDocumentWorkerSignatureRead,
    ExtraWorkTicketDetailsUpdate,
    ExtraWorkTicketEntryPayload,
    ExtraWorkTicketEntryRead,
    ExtraWorkTicketEntrySummaryRead,
    ExtraWorkTicketPhotoRead,
    ExtraWorkTicketPhotoSelectionUpdate,
    ExtraWorkTicketRead,
    ExtraWorkTicketTitleUpdate,
    ExtraWorkWorkerHours,
    ExtraWorkWorkerSignatureCreate,
)
from app.services.document_photo_optimizer import (
    OPTIMIZED_PHOTO_CONTENT_TYPE,
    create_document_photo_thumbnail,
    optimize_document_photo,
)
from app.services.extra_work_archive_service import (
    ExtraWorkArchiveService,
    is_extra_work_completed_status,
)
from app.services.extra_work_assignment import get_mobile_extra_work_assignment
from app.services.extra_work_document_context import (
    get_extra_work_assignment_context,
    resolve_extra_work_approval_place,
    resolve_extra_work_ticket_dates,
)
from app.services.extra_work_number import (
    build_extra_work_display_number,
    next_extra_work_sequence,
)
from app.services.extra_work_pdf_service import ExtraWorkPdfService
from app.services.extra_work_remarks import extra_work_remarks_fit
from app.services.photo_filename import (
    build_photo_filename,
    extra_work_photo_document_label,
    photo_extension_from_upload,
    user_photo_name,
)
from app.services.photo_limits import MAX_DOCUMENT_PHOTOS
from app.services.project_folder_service import ProjectFolderService
from app.services.project_storage_service import ProjectStorageService
from app.services.measurement_service import format_site_signature_location
from app.services.audit_service import AuditService
from app.services.project_record_status import validate_extra_work_status_promotion

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
LOGGER = logging.getLogger(__name__)

CustomerEmailStatus = tuple[datetime, bool | None]


class ExtraWorkService:
    def __init__(
        self,
        db: Session,
        *,
        archive_service: ExtraWorkArchiveService | None = None,
    ) -> None:
        self.db = db
        self.archive_service = archive_service or ExtraWorkArchiveService(db)

    def list_site_tickets(
        self,
        site_id: int,
        *,
        archived_only: bool = False,
        include_entry_summaries: bool = False,
    ) -> list[ExtraWorkTicketRead]:
        self._get_site(site_id)
        statement = (
            select(ExtraWorkTicket)
            .options(
                selectinload(ExtraWorkTicket.created_by).selectinload(User.person),
                selectinload(ExtraWorkTicket.deleted_by).selectinload(User.person),
                selectinload(ExtraWorkTicket.entries),
                selectinload(ExtraWorkTicket.photos),
            )
            .where(ExtraWorkTicket.site_id == site_id)
        )
        if archived_only:
            statement = statement.where(ExtraWorkTicket.deleted_at.is_not(None))
        else:
            statement = statement.where(ExtraWorkTicket.deleted_at.is_(None))
        tickets = list(
            self.db.scalars(
                statement.order_by(
                    ExtraWorkTicket.sequence_number.desc().nulls_last(),
                    ExtraWorkTicket.created_at.desc(),
                    ExtraWorkTicket.id.desc(),
                )
            ).all()
        )
        customer_email_statuses = self._latest_customer_email_statuses([ticket.id for ticket in tickets])
        return [
            self._build_ticket_read(
                ticket,
                customer_email_status=customer_email_statuses.get(ticket.id),
                include_entry_summaries=include_entry_summaries,
            )
            for ticket in tickets
        ]

    def create_site_ticket(
        self,
        *,
        site_id: int,
        current_user: User,
        payload: ExtraWorkTicketCreate,
    ) -> ExtraWorkTicketRead:
        # Serialize sequence allocation per site. The existing unique constraint
        # remains the final guard, while this row lock prevents ordinary office
        # and mobile requests from selecting the same next number concurrently.
        site = self._get_site(site_id, for_update=True)
        existing_numbers = self.db.execute(
            select(
                ExtraWorkTicket.sequence_number,
                ExtraWorkTicket.display_number,
            ).where(ExtraWorkTicket.site_id == site_id)
        ).tuples()
        next_sequence = next_extra_work_sequence(
            site_number=site.site_number,
            existing_numbers=existing_numbers,
        )
        ticket = ExtraWorkTicket(
            site_id=site_id,
            sequence_number=next_sequence,
            display_number=self._build_display_number(site, next_sequence),
            title=payload.title.strip() if payload.title and payload.title.strip() else None,
            kind=self._normalize_kind(
                payload.kind,
                default=(
                    EXTRA_WORK_APPROVAL_KIND
                    if site.requires_extra_work_approval
                    else EXTRA_WORK_BILLING_KIND
                ),
            ),
            approval_ticket_id=self._validate_approval_ticket_id(site_id, payload.approval_ticket_id),
            status="draft",
            created_by_user_id=current_user.id,
            notes=payload.notes.strip() if payload.notes and payload.notes.strip() else None,
            customer_name=self._clean_optional_text(site.customer),
        )
        self.db.add(ticket)
        self.db.commit()
        self.db.refresh(ticket)
        return self._build_ticket_read(ticket)

    def get_site_ticket_document(
        self,
        *,
        site_id: int,
        ticket_id: int,
        include_deleted: bool = False,
    ) -> ExtraWorkTicketDocumentRead:
        self._get_site(site_id)
        ticket = self._get_ticket_for_site(
            ticket_id,
            site_id,
            include_deleted=include_deleted,
        )
        entry = min(ticket.entries, key=lambda candidate: candidate.id, default=None)
        document_dates = resolve_extra_work_ticket_dates(
            ticket,
            get_extra_work_assignment_context(self.db, ticket),
        )
        worker_signature_place = (
            ticket.worker_signature_place
            or format_site_signature_location(ticket.site)
        )
        worker_signature_date = (
            ticket.worker_signature_date
            or (ticket.worker_signed_at.date() if ticket.worker_signed_at else None)
        )
        return ExtraWorkTicketDocumentRead(
            ticket=self._build_ticket_read(ticket),
            entry=ExtraWorkTicketEntryRead.model_validate(entry) if entry else None,
            resolved_dates=ExtraWorkTicketDocumentDatesRead(
                order_date=document_dates.order_date,
                approval_date=document_dates.approval_date,
                approval_place=resolve_extra_work_approval_place(ticket),
                execution_start=document_dates.execution_start,
                execution_end=document_dates.execution_end,
            ),
            worker_signature=ExtraWorkTicketDocumentWorkerSignatureRead(
                name=ticket.worker_signature_name,
                place=worker_signature_place,
                date=worker_signature_date,
                signed_at=ticket.worker_signed_at,
                strokes=ticket.worker_signature_strokes,
            ),
            customer_signature=ExtraWorkTicketDocumentCustomerSignatureRead(
                type=ticket.customer_signature_type,
                name=ticket.customer_signature_name,
                place=ticket.customer_signature_place,
                signed_at=ticket.customer_signed_at,
                strokes=ticket.customer_signature_strokes,
            ),
        )

    def update_site_ticket_document(
        self,
        *,
        site_id: int,
        ticket_id: int,
        current_user: User,
        payload: ExtraWorkTicketDocumentUpdate,
    ) -> ExtraWorkTicketDocumentRead:
        self._get_site(site_id)
        ticket = self._get_ticket_for_site(ticket_id, site_id, for_update=True)
        self._ensure_ticket_content_editable(ticket)
        entry_to_update = (
            self._get_first_ticket_entry(ticket.id, for_update=True)
            if payload.entry is not None
            else None
        )
        remarks = (
            self._clean_optional_multiline(payload.entry.remarks)
            if payload.entry is not None
            else None
        )
        if payload.entry is not None:
            self._validate_extra_work_remarks(
                remarks,
                entry_to_update.remarks if entry_to_update else None,
            )

        ticket.title = self._clean_optional_text(payload.title)
        if "customer_name" in payload.model_fields_set:
            ticket.customer_name = self._clean_optional_text(payload.customer_name)
        ticket.ordered_by_name = self._clean_optional_text(payload.ordered_by_name)
        ticket.ordered_by_company = self._clean_optional_text(payload.ordered_by_company)
        ticket.billing_type = payload.billing_type
        ticket.estimated_order_value = payload.estimated_order_value
        ticket.material_required = payload.material_required
        ticket.material_separate_attachment = payload.material_separate_attachment
        ticket.executed_by_lead_monteur = payload.executed_by_lead_monteur
        ticket.executed_by_monteur = payload.executed_by_monteur
        ticket.executed_by_helper = payload.executed_by_helper
        ticket.executor_other_name = self._clean_optional_text(payload.executor_other_name)
        ticket.work_description = self._clean_optional_multiline(payload.work_description)
        ticket.manual_order_date = payload.manual_order_date
        if "worker_signature_place" in payload.model_fields_set:
            ticket.worker_signature_place = self._clean_optional_text(
                payload.worker_signature_place
            )
        if "worker_signature_date" in payload.model_fields_set:
            ticket.worker_signature_date = payload.worker_signature_date
        if payload.worker_signature_strokes is not None:
            worker_signature_strokes = [
                [point.model_dump() for point in stroke]
                for stroke in payload.worker_signature_strokes
                if len(stroke) >= 2
            ]
            if worker_signature_strokes != (ticket.worker_signature_strokes or []):
                ticket.worker_signed_at = datetime.now(UTC)
            ticket.worker_signature_name = self._clean_optional_text(
                payload.worker_signature_name
            )
            ticket.worker_signature_strokes = worker_signature_strokes
        if payload.manual_execution_start is not None:
            ticket.manual_execution_week = None
            ticket.manual_execution_week_year = None
            ticket.manual_execution_start = payload.manual_execution_start
            ticket.manual_execution_end = payload.manual_execution_end
        else:
            ticket.manual_execution_week = payload.manual_execution_week
            ticket.manual_execution_week_year = payload.manual_execution_week_year
            ticket.manual_execution_start = None
            ticket.manual_execution_end = None
        self.db.add(ticket)

        if payload.entry is not None:
            self._validate_worker_person_ids(payload.entry.worker_rows)
            entry = entry_to_update
            worker_rows = [self._document_worker_row(row) for row in payload.entry.worker_rows]
            values = {
                "site_id": ticket.site_id,
                "component": payload.entry.component.strip(),
                "floor": payload.entry.floor.strip(),
                "room_number": self._clean_optional_text(payload.entry.room_number),
                "axis": self._clean_optional_text(payload.entry.axis),
                "remarks": remarks,
                "material_text": self._clean_optional_multiline(payload.entry.material_text),
                "estimated_hours": payload.entry.estimated_hours,
                "worker_rows": worker_rows,
            }
            if payload.entry.material_items is not None:
                values["material_items"] = [
                    item.model_dump() for item in payload.entry.material_items
                ]
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
        return self.get_site_ticket_document(site_id=site_id, ticket_id=ticket_id)

    def delete_site_ticket(self, *, site_id: int, ticket_id: int, current_user: User) -> None:
        self._get_site(site_id)
        ticket = self._get_ticket_for_site(ticket_id, site_id, for_update=True)
        ticket.deleted_at = datetime.now(UTC)
        ticket.deleted_by_user_id = current_user.id
        self.db.add(ticket)
        self.db.commit()

    def restore_site_ticket(
        self,
        *,
        site_id: int,
        ticket_id: int,
    ) -> ExtraWorkTicketRead:
        self._get_site(site_id)
        ticket = self._get_ticket_for_site(
            ticket_id,
            site_id,
            include_deleted=True,
            for_update=True,
        )
        if ticket.deleted_at is None:
            return self._build_ticket_read(ticket)
        ticket.deleted_at = None
        ticket.deleted_by_user_id = None
        ticket.deleted_by = None
        self.db.add(ticket)
        self.db.commit()
        self.db.refresh(ticket)
        return self._build_ticket_read(ticket)

    def promote_site_ticket_status(
        self,
        *,
        site_id: int,
        ticket_id: int,
        target_status: str,
        current_user: User,
    ) -> ExtraWorkTicketRead:
        self._get_site(site_id)
        ticket = self._get_ticket_for_site(ticket_id, site_id, for_update=True)
        previous_status = ticket.status
        normalized_previous = (previous_status or "").strip().lower()
        normalized_target = (target_status or "").strip().lower()
        if (
            normalized_previous == normalized_target
            and is_extra_work_completed_status(normalized_previous)
        ):
            self._archive_completed_ticket(ticket)
            return self._build_ticket_read(ticket)
        target_status = validate_extra_work_status_promotion(previous_status, target_status)
        ticket.status = target_status
        AuditService(self.db).record(
            user_id=current_user.id,
            action="extra_work.status_promoted",
            entity_type="extra_work_ticket",
            entity_id=ticket.id,
            old_value={"status": previous_status},
            new_value={"status": target_status},
        )
        self.db.add(ticket)
        self.db.commit()
        self.db.refresh(ticket)
        self._archive_completed_ticket(ticket)
        return self._build_ticket_read(ticket)

    def set_site_ticket_invoiced(
        self,
        *,
        site_id: int,
        ticket_id: int,
        is_invoiced: bool,
        current_user: User,
        schedule_completed_archive: Callable[[int, int], None] | None = None,
    ) -> ExtraWorkTicketRead:
        self._get_site(site_id)
        ticket = self._get_ticket_for_site(
            ticket_id,
            site_id,
            include_deleted=True,
            for_update=True,
        )
        previous_value = ticket.is_invoiced
        if previous_value == is_invoiced:
            return self._build_ticket_read(ticket)
        previous_status = ticket.status
        ticket.is_invoiced = is_invoiced
        if is_invoiced and ticket.invoiced_at is None:
            ticket.invoiced_at = datetime.now(UTC)
        status_changed = (
            is_invoiced
            and not is_extra_work_completed_status(previous_status)
        )
        if status_changed:
            ticket.status = "billed"
        AuditService(self.db).record(
            user_id=current_user.id,
            action="extra_work.invoiced_updated",
            entity_type="extra_work_ticket",
            entity_id=ticket.id,
            old_value={
                "is_invoiced": previous_value,
                "status": previous_status,
            },
            new_value={
                "is_invoiced": is_invoiced,
                "status": ticket.status,
            },
        )
        self.db.add(ticket)
        try:
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise
        self.db.refresh(ticket)
        if status_changed:
            if schedule_completed_archive is None:
                self._archive_completed_ticket(ticket)
            else:
                try:
                    schedule_completed_archive(ticket.site_id, ticket.id)
                except Exception:
                    LOGGER.exception(
                        "Extra-work PDF background archive scheduling failed after "
                        "status persistence: site_id=%s ticket_id=%s.",
                        ticket.site_id,
                        ticket.id,
                    )
        return self._build_ticket_read(ticket)

    def list_mobile_tickets(
        self,
        *,
        assignment_id: int,
        current_user: User,
    ) -> list[ExtraWorkTicketRead]:
        assignment = get_mobile_extra_work_assignment(self.db, assignment_id, current_user)
        return self.list_site_tickets(assignment.site_id)

    def create_mobile_ticket(
        self,
        *,
        assignment_id: int,
        current_user: User,
        payload: ExtraWorkTicketCreate | None = None,
    ) -> ExtraWorkTicketRead:
        assignment = get_mobile_extra_work_assignment(self.db, assignment_id, current_user)
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
        assignment = get_mobile_extra_work_assignment(self.db, assignment_id, current_user)
        ticket = self._get_ticket_for_site(ticket_id, assignment.site_id)
        return self._build_ticket_read(ticket)

    def submit_mobile_ticket(
        self,
        *,
        assignment_id: int,
        ticket_id: int,
        current_user: User,
    ) -> ExtraWorkTicketRead:
        assignment = get_mobile_extra_work_assignment(self.db, assignment_id, current_user)
        ticket = self._get_ticket_for_site(ticket_id, assignment.site_id)
        if ticket.status not in EXTRA_WORK_SUBMITTABLE_STATUSES:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Stundenzettel kann nicht zur Prüfung gesendet werden.")
        ticket.status = "submitted"
        ticket.submitted_by_user_id = current_user.id
        ticket.submitted_at = datetime.now(UTC)
        self.db.add(ticket)
        self.db.commit()
        self.db.refresh(ticket)
        self._archive_completed_ticket(ticket)
        return self._build_ticket_read(ticket)

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

    def update_mobile_ticket_title(
        self,
        *,
        assignment_id: int,
        ticket_id: int,
        current_user: User,
        payload: ExtraWorkTicketTitleUpdate,
    ) -> ExtraWorkTicketRead:
        assignment = get_mobile_extra_work_assignment(self.db, assignment_id, current_user)
        ticket = self._get_ticket_for_site(ticket_id, assignment.site_id)
        self._ensure_ticket_content_editable(ticket)
        ticket.title = self._clean_optional_text(payload.title)
        self.db.add(ticket)
        self.db.commit()
        self.db.refresh(ticket)
        return self._build_ticket_read(ticket)

    def update_mobile_ticket_details(
        self,
        *,
        assignment_id: int,
        ticket_id: int,
        current_user: User,
        payload: ExtraWorkTicketDetailsUpdate,
    ) -> ExtraWorkTicketRead:
        assignment = get_mobile_extra_work_assignment(self.db, assignment_id, current_user)
        ticket = self._get_ticket_for_site(ticket_id, assignment.site_id)
        self._ensure_ticket_content_editable(ticket)
        ticket.manual_order_date = payload.manual_order_date
        ticket.manual_execution_week = payload.manual_execution_week
        ticket.manual_execution_week_year = payload.manual_execution_week_year
        ticket.manual_execution_start = None
        ticket.manual_execution_end = None
        self.db.add(ticket)
        self.db.commit()
        self.db.refresh(ticket)
        return self._build_ticket_read(ticket)

    def get_mobile_ticket_entry(
        self,
        *,
        assignment_id: int,
        ticket_id: int,
        current_user: User,
    ) -> ExtraWorkTicketEntryRead | None:
        assignment = get_mobile_extra_work_assignment(self.db, assignment_id, current_user)
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
        assignment = get_mobile_extra_work_assignment(self.db, assignment_id, current_user)
        ticket = self._get_ticket_for_site(ticket_id, assignment.site_id)
        self._ensure_ticket_content_editable(ticket)
        entry = self.db.scalar(
            select(ExtraWorkTicketEntry)
            .where(ExtraWorkTicketEntry.ticket_id == ticket.id)
            .order_by(ExtraWorkTicketEntry.id)
        )
        remarks = self._clean_optional_multiline(payload.remarks)
        self._validate_extra_work_remarks(remarks, entry.remarks if entry else None)
        self._validate_worker_person_ids(payload.worker_rows)
        worker_rows = self._merge_mobile_worker_rows(
            list(entry.worker_rows or []) if entry else [],
            payload.worker_rows,
        )
        estimated_hours = payload.estimated_hours
        if (
            entry is not None
            and estimated_hours is None
            and (ticket.kind or EXTRA_WORK_BILLING_KIND) != EXTRA_WORK_APPROVAL_KIND
        ):
            # The compact mobile billing form has no editable hours-target
            # control. Preserve a value entered in the desktop master sheet,
            # including for older mobile clients that still submit null here.
            estimated_hours = entry.estimated_hours
        values = {
            "site_id": ticket.site_id,
            "component": payload.component.strip(),
            "floor": payload.floor.strip(),
            "room_number": self._clean_optional_text(payload.room_number),
            "axis": self._clean_optional_text(payload.axis),
            "remarks": remarks,
            "material_text": self._clean_optional_multiline(payload.material_text),
            "estimated_hours": estimated_hours,
            "worker_rows": worker_rows,
        }
        if payload.material_items is not None:
            values["material_items"] = [
                item.model_dump() for item in payload.material_items
            ]
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
        assignment = get_mobile_extra_work_assignment(self.db, assignment_id, current_user)
        ticket = self._get_ticket_for_site(ticket_id, assignment.site_id, for_update=True)
        if ticket.customer_signed_at is not None or (ticket.status or "").strip().lower() in {
            "signed",
            "customer_signed",
        }:
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
        customer_place = self._clean_optional_text(payload.customer_place)
        ticket.customer_signature_name = customer_name
        ticket.customer_signature_place = customer_place or format_site_signature_location(ticket.site)
        ticket.customer_signature_strokes = [
            [point.model_dump() for point in stroke]
            for stroke in valid_strokes
        ]
        ticket.customer_signed_at = datetime.now(UTC)
        ticket.status = "signed"
        self.db.add(ticket)
        self.db.flush()
        ExtraWorkPdfService(self.db).create_signed_snapshot(
            ticket=ticket,
            assignment=assignment,
        )
        self.db.commit()
        self.db.refresh(ticket)
        return self._build_ticket_read(ticket)

    def sign_mobile_ticket_worker(
        self,
        *,
        assignment_id: int,
        ticket_id: int,
        current_user: User,
        payload: ExtraWorkWorkerSignatureCreate,
    ) -> ExtraWorkTicketRead:
        assignment = get_mobile_extra_work_assignment(self.db, assignment_id, current_user)
        ticket = self._get_ticket_for_site(ticket_id, assignment.site_id)
        if ticket.status in {"billed", "closed"}:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Dieser Stundenzettel ist bereits abgeschlossen.",
            )

        submitted_worker_name = " ".join(payload.worker_name.split())
        worker_name = self._format_person_full_name(assignment.person) or submitted_worker_name
        if not worker_name:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Monteurname ist erforderlich.")
        valid_strokes = [stroke for stroke in payload.signature_strokes if len(stroke) >= 2]
        if not valid_strokes:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unterschrift ist erforderlich.")

        signed_at = datetime.now(UTC)
        ticket.worker_signature_name = worker_name
        ticket.worker_signature_place = (
            ticket.worker_signature_place
            or self._clean_optional_text(format_site_signature_location(ticket.site))
        )
        ticket.worker_signature_date = signed_at.date()
        ticket.worker_signature_strokes = [
            [point.model_dump() for point in stroke]
            for stroke in valid_strokes
        ]
        ticket.worker_signed_at = signed_at
        self.db.add(ticket)
        self.db.commit()
        self.db.refresh(ticket)
        return self._build_ticket_read(ticket)

    def list_mobile_ticket_photos(
        self,
        *,
        assignment_id: int,
        ticket_id: int,
        current_user: User,
    ) -> list[ExtraWorkTicketPhotoRead]:
        assignment = get_mobile_extra_work_assignment(self.db, assignment_id, current_user)
        return self.list_site_ticket_photos(
            site_id=assignment.site_id,
            ticket_id=ticket_id,
        )

    def list_site_ticket_photos(
        self,
        *,
        site_id: int,
        ticket_id: int,
        include_deleted: bool = False,
    ) -> list[ExtraWorkTicketPhotoRead]:
        self._get_site(site_id)
        ticket = self._get_ticket_for_site(
            ticket_id,
            site_id,
            include_deleted=include_deleted,
        )
        photos = list(
            self.db.scalars(
                select(ExtraWorkTicketPhoto)
                .options(selectinload(ExtraWorkTicketPhoto.uploaded_by).selectinload(User.person))
                .where(ExtraWorkTicketPhoto.extra_work_ticket_id == ticket.id)
                .order_by(ExtraWorkTicketPhoto.created_at, ExtraWorkTicketPhoto.id)
            )
        )
        return [self._build_mobile_photo(photo, ticket) for photo in photos]

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
        assignment = get_mobile_extra_work_assignment(self.db, assignment_id, current_user)
        ticket = self._get_ticket_for_site(
            ticket_id,
            assignment.site_id,
            for_update=True,
        )
        self._ensure_photo_upload_allowed(ticket)
        self._freeze_legacy_snapshot_before_photo_change(ticket, assignment)
        return self._upload_ticket_photo(
            ticket=ticket,
            current_user=current_user,
            filename=filename,
            content=content,
            content_type=content_type,
        )

    def upload_site_ticket_photo(
        self,
        *,
        site_id: int,
        ticket_id: int,
        current_user: User,
        filename: str | None,
        content: bytes,
        content_type: str | None,
    ) -> ExtraWorkTicketPhotoRead:
        self._get_site(site_id)
        ticket = self._get_ticket_for_site(
            ticket_id,
            site_id,
            include_deleted=True,
            for_update=True,
        )
        self._ensure_photo_upload_allowed(ticket)
        self._freeze_legacy_snapshot_before_photo_change(
            ticket,
            get_extra_work_assignment_context(self.db, ticket),
        )
        return self._upload_ticket_photo(
            ticket=ticket,
            current_user=current_user,
            filename=filename,
            content=content,
            content_type=content_type,
        )

    def _upload_ticket_photo(
        self,
        *,
        ticket: ExtraWorkTicket,
        current_user: User,
        filename: str | None,
        content: bytes,
        content_type: str | None,
    ) -> ExtraWorkTicketPhotoRead:
        current_photo_count = self.db.scalar(
            select(func.count(ExtraWorkTicketPhoto.id)).where(
                ExtraWorkTicketPhoto.extra_work_ticket_id == ticket.id
            )
        ) or 0
        if current_photo_count >= MAX_DOCUMENT_PHOTOS:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Maximal 5 Fotos erlaubt.")
        normalized_content_type = _normalize_content_type(content_type)
        if normalized_content_type not in EXTRA_WORK_PHOTO_CONTENT_TYPES:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Bitte ein Foto als JPEG, PNG, WebP oder HEIC hochladen.",
            )
        optimized_photo = optimize_document_photo(content)
        LOGGER.info(
            "Extra work photo optimized: ticket_id=%s bytes=%s->%s dimensions=%sx%s->%sx%s duration_ms=%.1f",
            ticket.id,
            optimized_photo.original_size_bytes,
            optimized_photo.optimized_size_bytes,
            optimized_photo.original_width,
            optimized_photo.original_height,
            optimized_photo.optimized_width,
            optimized_photo.optimized_height,
            optimized_photo.duration_ms,
        )
        thumbnail_content = create_document_photo_thumbnail(optimized_photo.content)

        folder = ProjectFolderService(self.db).get_project_folder_for_site_by_key(
            ticket.site_id,
            EXTRA_WORK_PHOTO_FOLDER_KEY,
            current_user,
        )
        existing_photo_names = set(
            self.db.scalars(
                select(ExtraWorkTicketPhoto.filename).where(
                    ExtraWorkTicketPhoto.extra_work_ticket_id == ticket.id
                )
            ).all()
        )
        upload_filename = build_photo_filename(
            site_name=ticket.site.name if ticket.site else "Baustelle",
            document_label=extra_work_photo_document_label(ticket),
            creator_name=user_photo_name(current_user),
            extension=photo_extension_from_upload(
                filename=filename,
                content_type=optimized_photo.content_type,
            ),
            existing_names=existing_photo_names,
        )
        uploaded = ProjectStorageService().upload_file_to_folder(
            drive_id=folder.external_drive_id,
            folder_item_id=folder.external_item_id,
            filename=upload_filename,
            content=optimized_photo.content,
            content_type=optimized_photo.content_type,
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
            content_type=optimized_photo.content_type,
            file_size_bytes=uploaded.get("size") if isinstance(uploaded.get("size"), int) else len(optimized_photo.content),
            thumbnail_content=thumbnail_content,
            thumbnail_content_type=OPTIMIZED_PHOTO_CONTENT_TYPE,
            content_sha256=sha256(optimized_photo.content).hexdigest(),
            customer_document_selected=True,
        )
        self.db.add(photo)
        self.db.commit()
        self.db.refresh(photo)
        return self._build_mobile_photo(photo, ticket)

    def get_mobile_ticket_photo_content(
        self,
        *,
        assignment_id: int,
        ticket_id: int,
        photo_id: int,
        current_user: User,
    ) -> tuple[bytes, str, str]:
        assignment = get_mobile_extra_work_assignment(self.db, assignment_id, current_user)
        return self.get_site_ticket_photo_content(
            site_id=assignment.site_id,
            ticket_id=ticket_id,
            photo_id=photo_id,
            current_user=current_user,
        )

    def get_site_ticket_photo_content(
        self,
        *,
        site_id: int,
        ticket_id: int,
        photo_id: int,
        current_user: User,
        include_deleted: bool = False,
    ) -> tuple[bytes, str, str]:
        self._get_site(site_id)
        ticket = self._get_ticket_for_site(
            ticket_id,
            site_id,
            include_deleted=include_deleted,
        )
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

    def get_site_ticket_photo_thumbnail(
        self,
        *,
        site_id: int,
        ticket_id: int,
        photo_id: int,
        current_user: User,
        include_deleted: bool = False,
    ) -> tuple[bytes, str]:
        self._get_site(site_id)
        ticket = self._get_ticket_for_site(
            ticket_id,
            site_id,
            include_deleted=include_deleted,
        )
        photo = self._get_photo_for_ticket(photo_id, ticket.id)
        if photo.thumbnail_content:
            return (
                photo.thumbnail_content,
                photo.thumbnail_content_type or OPTIMIZED_PHOTO_CONTENT_TYPE,
            )

        downloaded = ProjectStorageService().download_file_from_folder(
            drive_id=photo.external_drive_id,
            folder_item_id=self._get_photo_folder_item_id(photo, current_user),
            item_id=photo.external_item_id,
        )
        thumbnail = create_document_photo_thumbnail(bytes(downloaded["content"]))
        photo.thumbnail_content = thumbnail
        photo.thumbnail_content_type = OPTIMIZED_PHOTO_CONTENT_TYPE
        self.db.add(photo)
        self.db.commit()
        return thumbnail, OPTIMIZED_PHOTO_CONTENT_TYPE

    def delete_mobile_ticket_photo(
        self,
        *,
        assignment_id: int,
        ticket_id: int,
        photo_id: int,
        current_user: User,
    ) -> None:
        assignment = get_mobile_extra_work_assignment(self.db, assignment_id, current_user)
        ticket = self._get_ticket_for_site(
            ticket_id,
            assignment.site_id,
            for_update=True,
        )
        self._ensure_ticket_content_editable(ticket)
        photo = self._get_photo_for_ticket(photo_id, ticket.id)
        self._delete_ticket_photo(photo=photo, current_user=current_user)

    def delete_site_ticket_photo(
        self,
        *,
        site_id: int,
        ticket_id: int,
        photo_id: int,
        current_user: User,
    ) -> None:
        self._get_site(site_id)
        ticket = self._get_ticket_for_site(
            ticket_id,
            site_id,
            include_deleted=True,
            for_update=True,
        )
        self._ensure_ticket_content_editable(ticket)
        photo = self._get_photo_for_ticket(photo_id, ticket.id)
        self._delete_ticket_photo(photo=photo, current_user=current_user)

    def update_mobile_ticket_photo_caption(
        self,
        *,
        assignment_id: int,
        ticket_id: int,
        photo_id: int,
        caption: str | None,
        current_user: User,
    ) -> ExtraWorkTicketPhotoRead:
        assignment = get_mobile_extra_work_assignment(self.db, assignment_id, current_user)
        return self.update_site_ticket_photo_caption(
            site_id=assignment.site_id,
            ticket_id=ticket_id,
            photo_id=photo_id,
            caption=caption,
        )

    def update_site_ticket_photo_caption(
        self,
        *,
        site_id: int,
        ticket_id: int,
        photo_id: int,
        caption: str | None,
    ) -> ExtraWorkTicketPhotoRead:
        self._get_site(site_id)
        ticket = self._get_ticket_for_site(
            ticket_id,
            site_id,
            include_deleted=True,
            for_update=True,
        )
        self._ensure_ticket_content_editable(ticket)
        photo = self._get_photo_for_ticket(photo_id, ticket.id)
        photo.caption = caption
        self.db.commit()
        self.db.refresh(photo)
        return self._build_mobile_photo(photo)

    def update_mobile_ticket_photo_selection(
        self,
        *,
        assignment_id: int,
        ticket_id: int,
        photo_id: int,
        payload: ExtraWorkTicketPhotoSelectionUpdate,
        current_user: User,
    ) -> ExtraWorkTicketPhotoRead:
        assignment = get_mobile_extra_work_assignment(self.db, assignment_id, current_user)
        return self._update_ticket_photo_selection(
            site_id=assignment.site_id,
            ticket_id=ticket_id,
            photo_id=photo_id,
            selected=payload.selected,
            assignment=assignment,
        )

    def update_site_ticket_photo_selection(
        self,
        *,
        site_id: int,
        ticket_id: int,
        photo_id: int,
        payload: ExtraWorkTicketPhotoSelectionUpdate,
    ) -> ExtraWorkTicketPhotoRead:
        self._get_site(site_id)
        ticket = self._get_ticket_for_site(ticket_id, site_id)
        return self._update_ticket_photo_selection(
            site_id=site_id,
            ticket_id=ticket_id,
            photo_id=photo_id,
            selected=payload.selected,
            assignment=get_extra_work_assignment_context(self.db, ticket),
        )

    def _update_ticket_photo_selection(
        self,
        *,
        site_id: int,
        ticket_id: int,
        photo_id: int,
        selected: bool,
        assignment: Assignment | None,
    ) -> ExtraWorkTicketPhotoRead:
        ticket = self._get_ticket_for_site(ticket_id, site_id, include_deleted=True, for_update=True)
        if ticket.deleted_at is not None:
            raise HTTPException(status.HTTP_409_CONFLICT, "Archivierte Zusatzaufträge können nicht bearbeitet werden.")
        self._freeze_legacy_snapshot_before_photo_change(ticket, assignment)
        photo = self._get_photo_for_ticket(photo_id, ticket.id)
        if self._photo_is_signed_member(ticket, photo.id):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Dieses Foto ist Bestandteil des unveränderlichen unterschriebenen Dokuments.",
            )
        photo.customer_document_selected = selected
        self.db.add(photo)
        self.db.commit()
        self.db.refresh(photo)
        return self._build_mobile_photo(photo, ticket)

    def _delete_ticket_photo(
        self,
        *,
        photo: ExtraWorkTicketPhoto,
        current_user: User,
    ) -> None:
        ProjectStorageService().delete_file_from_folder(
            drive_id=photo.external_drive_id,
            folder_item_id=self._get_photo_folder_item_id(photo, current_user),
            item_id=photo.external_item_id,
        )
        self.db.delete(photo)
        self.db.commit()

    def _get_site(self, site_id: int, *, for_update: bool = False) -> Site:
        statement = select(Site).where(Site.id == site_id)
        if for_update:
            statement = statement.with_for_update()
        site = self.db.scalar(statement)
        if site is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Baustelle nicht gefunden.")
        return site

    def _get_ticket_for_site(
        self,
        ticket_id: int,
        site_id: int,
        *,
        include_deleted: bool = False,
        for_update: bool = False,
    ) -> ExtraWorkTicket:
        statement = (
            select(ExtraWorkTicket)
            .options(
                selectinload(ExtraWorkTicket.site),
                selectinload(ExtraWorkTicket.created_by).selectinload(User.person),
                selectinload(ExtraWorkTicket.deleted_by).selectinload(User.person),
                selectinload(ExtraWorkTicket.entries),
                selectinload(ExtraWorkTicket.photos),
            )
            .where(
                ExtraWorkTicket.id == ticket_id,
                ExtraWorkTicket.site_id == site_id,
            )
        )
        if not include_deleted:
            statement = statement.where(ExtraWorkTicket.deleted_at.is_(None))
        if for_update:
            statement = statement.with_for_update()
        ticket = self.db.scalar(statement)
        if ticket is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Stundenzettel nicht gefunden.")
        return ticket

    def _get_first_ticket_entry(
        self,
        ticket_id: int,
        *,
        for_update: bool = False,
    ) -> ExtraWorkTicketEntry | None:
        statement = (
            select(ExtraWorkTicketEntry)
            .where(ExtraWorkTicketEntry.ticket_id == ticket_id)
            .order_by(ExtraWorkTicketEntry.id)
        )
        if for_update:
            statement = statement.with_for_update()
        return self.db.scalar(statement)

    @staticmethod
    def _ensure_ticket_content_editable(ticket: ExtraWorkTicket) -> None:
        if ticket.deleted_at is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Archivierte Zusatzaufträge können nicht bearbeitet werden.",
            )
        if ticket.customer_signed_at is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Der Zusatzauftrag kann nach Kundenunterschrift nicht mehr geändert werden.",
            )
        normalized_status = (ticket.status or "").strip().lower()
        if normalized_status in {"signed", "customer_signed"} or is_extra_work_completed_status(
            normalized_status
        ):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Der abgeschlossene Zusatzauftrag kann nicht mehr geändert werden.",
            )

    def _validate_worker_person_ids(self, rows: list[ExtraWorkWorkerHours]) -> None:
        requested_ids = {row.person_id for row in rows if row.person_id is not None}
        if not requested_ids:
            return
        existing_ids = set(
            self.db.scalars(select(Person.id).where(Person.id.in_(requested_ids))).all()
        )
        if existing_ids != requested_ids:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                "Mindestens ein ausgewählter Monteur ist nicht vorhanden.",
            )

    @staticmethod
    def _document_worker_row(row: ExtraWorkWorkerHours) -> dict[str, object]:
        values = row.model_dump(exclude_unset=True)
        if "worker_name" in values:
            values["worker_name"] = str(values["worker_name"] or "").strip()
        return values

    @classmethod
    def _merge_mobile_worker_rows(
        cls,
        existing_rows: list[dict[str, object]],
        payload_rows: list[ExtraWorkWorkerHours],
    ) -> list[dict[str, object]]:
        extension_keys = {
            "person_id",
            *{
                f"{weekday}_surcharge_{percentage}_hours"
                for weekday in (
                    "monday",
                    "tuesday",
                    "wednesday",
                    "thursday",
                    "friday",
                    "saturday",
                    "sunday",
                )
                for percentage in (25, 50)
            },
        }
        existing_person_ids = [
            value
            for existing in existing_rows
            if isinstance((value := existing.get("person_id")), int)
            and not isinstance(value, bool)
        ]
        payload_person_ids = [
            row.person_id for row in payload_rows if row.person_id is not None
        ]
        existing_person_id_counts = Counter(existing_person_ids)
        payload_person_id_counts = Counter(payload_person_ids)
        unique_existing_by_person_id = {
            person_id: existing
            for existing in existing_rows
            if isinstance((person_id := existing.get("person_id")), int)
            and not isinstance(person_id, bool)
            and existing_person_id_counts[person_id] == 1
            and payload_person_id_counts[person_id] == 1
        }

        existing_names = [
            str(existing.get("worker_name") or "").strip()
            for existing in existing_rows
        ]
        payload_names = [row.worker_name.strip() for row in payload_rows]
        existing_name_counts = Counter(existing_names)
        payload_name_counts = Counter(payload_names)
        unique_existing_by_name = {
            name: existing
            for name, existing in zip(existing_names, existing_rows, strict=True)
            if name
            and existing_name_counts[name] == 1
            and payload_name_counts[name] == 1
        }

        merged_rows: list[dict[str, object]] = []
        for row in payload_rows:
            values = cls._document_worker_row(row)
            if row.person_id is not None:
                existing = unique_existing_by_person_id.get(row.person_id, {})
            else:
                existing = unique_existing_by_name.get(row.worker_name.strip(), {})
            for key in extension_keys:
                if key not in values and key in existing:
                    values[key] = existing[key]
            merged_rows.append(values)
        return merged_rows

    def _build_ticket_read(
        self,
        ticket: ExtraWorkTicket,
        customer_email_status: CustomerEmailStatus | None = None,
        *,
        include_entry_summaries: bool = False,
    ) -> ExtraWorkTicketRead:
        result = ExtraWorkTicketRead.model_validate(ticket)
        result.created_by_name = self._format_user_display_name(ticket.created_by)
        result.deleted_by_name = self._format_user_display_name(ticket.deleted_by)
        if include_entry_summaries:
            result.entry_summaries = [
                self._build_ticket_entry_summary(entry)
                for entry in sorted(ticket.entries or [], key=lambda candidate: candidate.id)
            ]
        if customer_email_status is not None:
            result.customer_email_sent_at = customer_email_status[0]
            result.customer_email_signature_present = (
                customer_email_status[1]
                if customer_email_status[1] is not None
                else ticket.customer_signed_at is not None
            )
        return result

    @staticmethod
    def _build_ticket_entry_summary(
        entry: ExtraWorkTicketEntry,
    ) -> ExtraWorkTicketEntrySummaryRead:
        worker_names = [
            str(row.get("worker_name") or "").strip()
            for row in entry.worker_rows or []
            if str(row.get("worker_name") or "").strip()
        ]
        material_descriptions = [
            str(item.get("description") or "").strip()
            for item in entry.material_items or []
            if isinstance(item, dict) and str(item.get("description") or "").strip()
        ]
        return ExtraWorkTicketEntrySummaryRead(
            id=entry.id,
            component=entry.component,
            floor=entry.floor,
            room_number=entry.room_number,
            axis=entry.axis,
            remarks=entry.remarks,
            material_text=entry.material_text,
            material_descriptions=material_descriptions,
            worker_names=worker_names,
            estimated_hours=float(entry.estimated_hours) if entry.estimated_hours is not None else None,
        )

    def _latest_customer_email_statuses(self, ticket_ids: list[int]) -> dict[int, CustomerEmailStatus]:
        if not ticket_ids:
            return {}
        logs = list(
            self.db.scalars(
                select(AuditLog)
                .where(
                    AuditLog.action == "extra_work.email_sent",
                    AuditLog.entity_type == "extra_work_ticket",
                    AuditLog.entity_id.in_(ticket_ids),
                )
                .order_by(AuditLog.entity_id, AuditLog.created_at.desc(), AuditLog.id.desc())
            )
        )
        statuses: dict[int, CustomerEmailStatus] = {}
        for log in logs:
            if log.entity_id is None or log.entity_id in statuses:
                continue
            payload = log.new_value_json or {}
            signature_present = payload.get("customer_signature_present")
            statuses[log.entity_id] = (
                log.created_at,
                signature_present if isinstance(signature_present, bool) else None,
            )
        return statuses

    def _build_mobile_photo(
        self,
        photo: ExtraWorkTicketPhoto,
        ticket: ExtraWorkTicket | None = None,
    ) -> ExtraWorkTicketPhotoRead:
        owner = ticket or photo.ticket
        return ExtraWorkTicketPhotoRead(
            id=photo.id,
            site_id=photo.site_id,
            extra_work_ticket_id=photo.extra_work_ticket_id,
            filename=photo.filename,
            content_type=photo.content_type,
            file_size_bytes=photo.file_size_bytes,
            external_web_url=photo.external_web_url,
            uploaded_by_name=self._format_user_display_name(photo.uploaded_by),
            caption=photo.caption,
            taken_at=photo.taken_at,
            created_at=photo.created_at,
            updated_at=photo.updated_at,
            customer_document_selected=photo.customer_document_selected,
            signed_document_member=self._photo_is_signed_member(owner, photo.id),
        )

    @staticmethod
    def _photo_is_signed_member(ticket: ExtraWorkTicket, photo_id: int) -> bool:
        return any(
            isinstance(item, dict) and item.get("photo_id") == photo_id
            for item in (ticket.signed_photo_manifest or {}).get("photos", [])
        )

    @staticmethod
    def _ensure_photo_upload_allowed(ticket: ExtraWorkTicket) -> None:
        if ticket.deleted_at is not None:
            raise HTTPException(status.HTTP_409_CONFLICT, "Archivierte Zusatzaufträge können nicht bearbeitet werden.")

    def _freeze_legacy_snapshot_before_photo_change(
        self,
        ticket: ExtraWorkTicket,
        assignment: Assignment | None,
    ) -> None:
        if ticket.customer_signed_at is not None and ticket.signed_pdf_content is None:
            ExtraWorkPdfService(self.db).create_signed_snapshot(
                ticket=ticket,
                assignment=assignment,
                snapshot_kind="legacy_frozen_current_state",
                photos=sorted(ticket.photos or [], key=lambda photo: (photo.created_at, photo.id)),
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

    @staticmethod
    def _format_person_full_name(person: object | None) -> str | None:
        if person is None:
            return None
        first_name = (getattr(person, "first_name", None) or "").strip()
        last_name = (getattr(person, "last_name", None) or "").strip()
        full_name = " ".join(part for part in (first_name, last_name) if part)
        return full_name or (getattr(person, "display_name", None) or "").strip() or None

    def _validate_approval_ticket_id(self, site_id: int, approval_ticket_id: int | None) -> int | None:
        if approval_ticket_id is None:
            return None
        approval_ticket = self._get_ticket_for_site(approval_ticket_id, site_id)
        if approval_ticket.kind != EXTRA_WORK_APPROVAL_KIND:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Verknüpfte Freigabe muss eine Stundenfreigabe sein.")
        return approval_ticket.id

    def _archive_completed_ticket(self, ticket: ExtraWorkTicket) -> None:
        if not is_extra_work_completed_status(ticket.status):
            return
        try:
            self.archive_service.archive_completed_ticket(
                site_id=ticket.site_id,
                ticket_id=ticket.id,
            )
        except Exception:
            # The business transaction is already committed at this point. A
            # SharePoint outage must never roll back or hide the completed status.
            LOGGER.exception(
                "Extra-work PDF archive failed after status persistence: "
                "site_id=%s ticket_id=%s status=%s.",
                ticket.site_id,
                ticket.id,
                ticket.status,
            )

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
    def _clean_optional_multiline(value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.replace("\r\n", "\n").replace("\r", "\n")
        return normalized if normalized.strip() else None

    @staticmethod
    def _validate_extra_work_remarks(value: str | None, stored_value: str | None) -> None:
        if extra_work_remarks_fit(value):
            return
        normalized_stored = ExtraWorkService._clean_optional_multiline(stored_value)
        if value == normalized_stored:
            # Preserve legacy overflow when another field is edited. The PDF
            # endpoint reports it explicitly until the remark itself is shortened.
            return
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "Maximale Länge für die PDF erreicht. Bitte die Bemerkungen kürzen.",
        )

    @staticmethod
    def _build_display_number(site: Site, sequence_number: int) -> str:
        try:
            return build_extra_work_display_number(site.site_number, sequence_number)
        except ValueError as error:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Für die Vergabe einer Zusatzauftragsnummer fehlt die Projektnummer.",
            ) from error


def _normalize_content_type(value: str | None) -> str:
    return (value or "application/octet-stream").split(";", 1)[0].strip().lower()
