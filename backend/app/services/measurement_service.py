from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal
import logging
import re
from zoneinfo import ZoneInfo

from fastapi import HTTPException, status
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session, selectinload, with_loader_criteria

from app.models.assignment import Assignment
from app.models.audit_log import AuditLog
from app.models.dashboard_message_dismissal import DashboardMessageDismissal
from app.models.extra_work_ticket import ExtraWorkTicket
from app.models.enums import (
    MeasurementBatchOrigin,
    MeasurementPositionMode,
    PersonEmploymentStatus,
    PersonType,
    UserRole,
)
from app.models.person import Person
from app.models.site import Site
from app.models.site_measurement_item import (
    SiteMeasurementBase,
    SiteMeasurementAreaRow,
    SiteMeasurementBatch,
    SiteMeasurementBatchPhoto,
    SiteMeasurementEntry,
    SiteMeasurementItem,
)
from app.models.user import User
from app.models.work_time_entry import WorkTimeEntry
from app.schemas.measurement import (
    CustomerSignatureCreate,
    DashboardMessageRead,
    DashboardMessagesSummaryRead,
    MeasurementBaseRead,
    MeasurementBaseUpdate,
    MeasurementAreaRowCreate,
    MeasurementAreaRowRead,
    MeasurementEntryCreate,
    MeasurementDashboardSubmissionRead,
    MeasurementEntryRead,
    MeasurementItemUpdate,
    MeasurementItemRead,
    MobileMeasurementBatchAvailableActionsRead,
    MobileMeasurementBatchBlockReasonsRead,
    OfficeMeasurementBatchCreate,
    MobileMeasurementFreeItemCreate,
    MeasurementTimeAnalysisExtraWorkTicketRead,
    MeasurementTimeAnalysisRead,
    MeasurementTimeAnalysisRowRead,
    MeasurementTimeAnalysisTotalsRead,
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
from app.services.document_photo_optimizer import optimize_document_photo
from app.services.photo_filename import (
    build_photo_filename,
    measurement_photo_document_label,
    photo_extension_from_upload,
    user_photo_name,
)
from app.services.photo_limits import MAX_DOCUMENT_PHOTOS
from app.services.project_folder_service import ProjectFolderService
from app.services.project_storage_service import ProjectStorageService
from app.services.push_notification_service import PushNotificationService
from app.services.time_entry_service import TimeEntryService
from app.services.audit_service import AuditService
from app.services.project_record_status import validate_measurement_status_promotion


MEASUREMENT_PHOTO_FOLDER_KEY = "fotos"
MEASUREMENT_ARCHIVE_FOLDER_KEY = "aufmass"
MEASUREMENT_ARCHIVE_TIMEZONE = ZoneInfo("Europe/Berlin")
MEASUREMENT_COMPLETED_BATCH_STATUSES = frozenset({
    "billed",
    "approved",
    "closed",
    "completed",
    "finalized",
    "abgeschlossen",
})
MEASUREMENT_OFFICE_EDIT_LOCKED_BATCH_STATUSES = MEASUREMENT_COMPLETED_BATCH_STATUSES | frozenset({
    "archived",
    "customer_signed",
    "signed",
    "unterschrieben",
})
MEASUREMENT_PHOTO_CONTENT_TYPES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/heic": ".heic",
    "image/heif": ".heif",
}
LOGGER = logging.getLogger(__name__)

CustomerEmailStatus = tuple[datetime, bool | None]


def _measurement_entry_area_key(value: str) -> str:
    return " ".join(value.split()).casefold()


def _measurement_entry_sort_key(entry: SiteMeasurementEntry) -> tuple[str, str, int]:
    return (
        _datetime_as_string(entry.updated_at) or "",
        _datetime_as_string(entry.created_at) or "",
        entry.id or 0,
    )


def _measurement_position_key(value: str | None) -> str:
    return re.sub(r"\s+", "", value or "").casefold()


def _is_technical_free_measurement_position(value: str | None) -> bool:
    if value is None:
        return False
    normalized = value.strip().upper()
    if not normalized.startswith("FREI-"):
        return False
    return normalized.removeprefix("FREI-").isdigit()


def _current_measurement_entries(entries: list[SiteMeasurementEntry]) -> list[SiteMeasurementEntry]:
    current_by_cell: dict[tuple[int, int, str], SiteMeasurementEntry] = {}
    for entry in entries:
        key = (
            entry.measurement_batch_id,
            entry.measurement_item_id,
            _measurement_entry_area_key(entry.area_or_comment),
        )
        current_entry = current_by_cell.get(key)
        if current_entry is None or _measurement_entry_sort_key(entry) > _measurement_entry_sort_key(current_entry):
            current_by_cell[key] = entry
    return sorted(current_by_cell.values(), key=lambda entry: (entry.created_at, entry.id))


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
        referenced_entry_count = self.db.scalar(
            select(func.count(SiteMeasurementEntry.id))
            .join(
                SiteMeasurementItem,
                SiteMeasurementEntry.measurement_item_id == SiteMeasurementItem.id,
            )
            .where(
                SiteMeasurementItem.site_id == site_id,
                SiteMeasurementItem.measurement_base_id == base.id,
            )
        ) or 0
        linked_item_count = self.db.scalar(
            select(func.count(SiteMeasurementItem.id)).where(
                SiteMeasurementItem.site_id == site_id,
                SiteMeasurementItem.linked_measurement_item_id.in_(
                    select(SiteMeasurementItem.id).where(
                        SiteMeasurementItem.site_id == site_id,
                        SiteMeasurementItem.measurement_base_id == base.id,
                    )
                ),
            )
        ) or 0
        if batch_count > 0 or referenced_entry_count > 0 or linked_item_count > 0:
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
            .where(
                SiteMeasurementItem.site_id == site_id,
                SiteMeasurementItem.is_hidden.is_(False),
            )
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
                    selectinload(SiteMeasurementBatch.free_items),
                    selectinload(SiteMeasurementBatch.area_rows).selectinload(
                        SiteMeasurementAreaRow.created_by
                    ),
                    selectinload(SiteMeasurementBatch.measurement_base),
                    selectinload(SiteMeasurementBatch.created_by).selectinload(User.person),
                    selectinload(SiteMeasurementBatch.submitted_by).selectinload(User.person),
                    selectinload(SiteMeasurementBatch.assigned_employee),
                )
                .where(SiteMeasurementBatch.site_id == assignment.site_id)
                .where(SiteMeasurementBatch.deleted_at.is_(None))
                .where(SiteMeasurementBatch.origin != MeasurementBatchOrigin.OFFICE.value)
                .order_by(
                    SiteMeasurementBatch.created_at.desc(),
                    SiteMeasurementBatch.id.desc(),
                )
            ).all()
        )
        active_base_id = self._get_active_measurement_base_id(assignment.site_id)
        customer_email_statuses = self._latest_customer_email_statuses(
            entity_type="measurement_batch",
            action="measurement.email_sent",
            entity_ids=[batch.id for batch in batches],
        )
        photo_counts = self._photo_counts_by_batch_id(batch_ids=[batch.id for batch in batches])
        return [
            self._build_mobile_batch(
                batch,
                active_base_id=active_base_id,
                customer_email_status=customer_email_statuses.get(batch.id),
                current_user=current_user,
                photo_count=photo_counts.get(batch.id, 0),
            )
            for batch in batches
        ]

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
            origin=MeasurementBatchOrigin.MONTEUR.value,
            position_mode=MeasurementPositionMode.OFFER_BASED.value,
            creator_role_at_creation=current_user.role.value,
            created_by_user_id=current_user.id,
        )
        self.db.add(batch)
        self.db.commit()
        self.db.refresh(batch)
        return self._build_mobile_batch(batch, active_base_id=measurement_base.id, current_user=current_user)

    def list_office_measurement_workers(self, site_id: int) -> list[Person]:
        self._get_site(site_id)
        return list(
            self.db.scalars(
                select(Person)
                .join(User, User.person_id == Person.id)
                .where(
                    Person.person_type == PersonType.INTERNAL,
                    Person.is_active.is_(True),
                    Person.employment_status == PersonEmploymentStatus.ACTIVE.value,
                    Person.deleted_at.is_(None),
                    User.role == UserRole.MONTEUR,
                    User.is_active.is_(True),
                )
                .distinct()
                .order_by(Person.last_name, Person.first_name, Person.id)
            ).all()
        )

    def create_office_batch(
        self,
        *,
        site_id: int,
        current_user: User,
        payload: OfficeMeasurementBatchCreate,
    ) -> MobileMeasurementBatchRead:
        self._get_site(site_id)
        existing_request = self.db.scalar(
            select(SiteMeasurementBatch)
            .options(
                selectinload(SiteMeasurementBatch.entries).selectinload(
                    SiteMeasurementEntry.measurement_item
                ),
                selectinload(SiteMeasurementBatch.free_items),
                selectinload(SiteMeasurementBatch.area_rows),
                selectinload(SiteMeasurementBatch.measurement_base),
                selectinload(SiteMeasurementBatch.created_by).selectinload(User.person),
                selectinload(SiteMeasurementBatch.assigned_employee),
            )
            .where(SiteMeasurementBatch.request_id == payload.request_id)
        )
        if existing_request is not None:
            if (
                existing_request.site_id != site_id
                or existing_request.created_by_user_id != current_user.id
            ):
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "Diese Anforderungs-ID wurde bereits verwendet.",
                )
            return self._build_mobile_batch(
                existing_request,
                active_base_id=self._get_active_measurement_base_id(site_id),
            )

        area_location = " ".join(payload.area_location.split())
        if not area_location:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Bereich/Ort ist erforderlich.")

        assigned_employee = None
        if payload.assigned_employee_id is not None:
            assigned_employee = self.db.scalar(
                select(Person)
                .join(User, User.person_id == Person.id)
                .where(
                    Person.id == payload.assigned_employee_id,
                    Person.person_type == PersonType.INTERNAL,
                    Person.is_active.is_(True),
                    Person.employment_status == PersonEmploymentStatus.ACTIVE.value,
                    Person.deleted_at.is_(None),
                    User.role == UserRole.MONTEUR,
                    User.is_active.is_(True),
                )
            )
            if assigned_employee is None:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_ENTITY,
                    "Der ausgewählte Monteur ist nicht aktiv oder nicht zuordenbar.",
                )

        duplicate = self.db.scalar(
            select(SiteMeasurementBatch.id).where(
                SiteMeasurementBatch.site_id == site_id,
                SiteMeasurementBatch.status == "draft",
                SiteMeasurementBatch.deleted_at.is_(None),
                SiteMeasurementBatch.area_location == area_location,
                SiteMeasurementBatch.measurement_date == payload.measurement_date,
            )
        )
        if duplicate is not None and not payload.allow_duplicate:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Für diesen Bereich und dieses Datum besteht bereits ein offener Entwurf. "
                "Die bewusste Anlage eines weiteren Aufmaßes muss bestätigt werden.",
            )

        next_number = (
            self.db.scalar(
                select(func.max(SiteMeasurementBatch.number)).where(
                    SiteMeasurementBatch.site_id == site_id
                )
            )
            or 0
        ) + 1
        batch = SiteMeasurementBatch(
            site_id=site_id,
            measurement_base_id=None,
            number=next_number,
            title=f"Aufmaß {next_number}",
            status="draft",
            origin=MeasurementBatchOrigin.OFFICE.value,
            position_mode=MeasurementPositionMode.BLANK.value,
            creator_role_at_creation=current_user.role.value,
            area_location=area_location,
            measurement_date=payload.measurement_date,
            assigned_employee_id=assigned_employee.id if assigned_employee else None,
            request_id=payload.request_id,
            created_by_user_id=current_user.id,
        )
        self.db.add(batch)
        self.db.commit()
        return self._build_mobile_batch(
            self._get_batch_for_site(batch.id, site_id),
            active_base_id=self._get_active_measurement_base_id(site_id),
        )

    def create_mobile_area_row(
        self,
        *,
        assignment_id: int,
        batch_id: int,
        current_user: User,
        payload: MeasurementAreaRowCreate,
    ) -> MeasurementAreaRowRead:
        assignment = self._get_user_assignment(assignment_id, current_user)
        batch = self._get_batch_for_site(batch_id, assignment.site_id)
        if batch.status != "draft":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Dieses Aufmaß wurde bereits zur Prüfung gesendet.",
            )
        self._ensure_mobile_batch_can_be_edited_by_worker(batch)

        area_or_comment = " ".join(payload.area_or_comment.split())
        if not area_or_comment:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Bereich oder Kommentar ist erforderlich.")

        existing_rows = list(
            self.db.scalars(
                select(SiteMeasurementAreaRow)
                .where(SiteMeasurementAreaRow.measurement_batch_id == batch.id)
                .order_by(SiteMeasurementAreaRow.sort_order, SiteMeasurementAreaRow.id)
            ).all()
        )
        area_key = self._measurement_area_key(area_or_comment)
        for row in existing_rows:
            if self._measurement_area_key(row.area_or_comment) == area_key:
                return self._build_area_row(row)

        next_sort_order = (max((row.sort_order for row in existing_rows), default=-1) + 1)
        row = SiteMeasurementAreaRow(
            measurement_batch_id=batch.id,
            site_id=batch.site_id,
            area_or_comment=area_or_comment,
            sort_order=next_sort_order,
            created_by_user_id=current_user.id,
        )
        self.db.add(row)
        self.db.commit()
        self.db.refresh(row)
        return self._build_area_row(row)

    def list_mobile_batch_items(
        self, *, assignment_id: int, batch_id: int, current_user: User
    ) -> list[MobileMeasurementItemRead]:
        assignment = self._get_user_assignment(assignment_id, current_user)
        batch = self._get_batch_for_site(batch_id, assignment.site_id)
        items = self._list_batch_position_items(batch)
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
        if batch.status == "draft" and batch.origin != MeasurementBatchOrigin.OFFICE.value:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Entwürfe werden mobil bearbeitet.",
            )

        item = self.db.get(SiteMeasurementItem, measurement_item_id)
        item_belongs_to_batch = item is not None and self._measurement_item_is_available_for_batch(
            batch=batch,
            item=item,
        )
        if not item_belongs_to_batch:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Aufmaßposition nicht gefunden.")
        assert item is not None

        comment = payload.area_or_comment.strip()
        if not comment:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Bereich oder Kommentar ist erforderlich.")

        self._delete_existing_entries_for_cell(
            batch_id=batch.id,
            measurement_item_id=item.id,
            area_or_comment=comment,
        )
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

    def create_site_free_item(
        self,
        *,
        site_id: int,
        batch_id: int,
        current_user: User,
        payload: MobileMeasurementFreeItemCreate,
    ) -> MobileMeasurementItemRead:
        self._get_site(site_id)
        batch = self._get_batch_for_site(batch_id, site_id)
        if batch.status == "draft" and batch.origin != MeasurementBatchOrigin.OFFICE.value:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Entwürfe werden mobil bearbeitet.",
            )

        description = " ".join(payload.description.split())
        unit = payload.unit.strip()
        is_blank_batch = batch.position_mode == MeasurementPositionMode.BLANK.value
        if not description and not is_blank_batch:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Kurztext ist erforderlich.")
        if not unit and not is_blank_batch:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Einheit ist erforderlich.")
        measurement_base_ids = self._measurement_catalog_base_ids(batch)
        position = payload.position.strip() if payload.position else ""
        linked_measurement_item = self._get_measurement_catalog_item(
            site_id=site_id,
            measurement_item_id=payload.linked_measurement_item_id,
            measurement_base_ids=measurement_base_ids,
        )
        if linked_measurement_item is None and position:
            linked_measurement_item = self._find_measurement_catalog_item_by_position(
                site_id=site_id,
                position=position,
                measurement_base_ids=measurement_base_ids,
            )

        if linked_measurement_item is not None:
            position = linked_measurement_item.position
        elif position:
            position_scope = [SiteMeasurementItem.site_id == batch.site_id]
            if is_blank_batch:
                position_scope.append(SiteMeasurementItem.measurement_batch_id == batch.id)
            else:
                position_scope.append(SiteMeasurementItem.measurement_base_id == batch.measurement_base_id)
            existing_position = self.db.scalar(
                select(SiteMeasurementItem.id).where(
                    *position_scope,
                    func.lower(SiteMeasurementItem.position) == position.lower(),
                )
            )
            if existing_position is not None:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "Diese Positionsnummer existiert in diesem Aufmaß bereits.",
                )
        else:
            position = self._next_free_measurement_position(batch)

        next_sort_order = self._next_site_batch_column_sort_order(batch)

        item = SiteMeasurementItem(
            site_id=batch.site_id,
            measurement_base_id=None if is_blank_batch else batch.measurement_base_id,
            measurement_batch_id=batch.id,
            linked_measurement_item_id=(
                linked_measurement_item.id if linked_measurement_item is not None else None
            ),
            source_file_name=None,
            source_project_number=None,
            source_invoice_number=None,
            source_customer_name=None,
            source_section_key="office_extra",
            source_section_title="Büro-Zusatzposition",
            position=position,
            description=description,
            list_quantity=None,
            unit=unit,
            minutes_per_unit=None,
            list_minutes_total=None,
            is_nep=False,
            is_free_position=True,
            sort_order=next_sort_order,
        )
        self.db.add(item)
        self.db.flush()

        if payload.quantity != 0 or payload.area_or_comment is not None:
            comment = " ".join((payload.area_or_comment or "").split()) or "Allgemein"
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
        self.db.refresh(item)
        return self._build_mobile_item(item, batch.id)

    def update_site_free_item(
        self,
        *,
        site_id: int,
        batch_id: int,
        measurement_item_id: int,
        payload: MeasurementItemUpdate,
    ) -> MobileMeasurementItemRead:
        self._get_site(site_id)
        batch = self._get_batch_for_site(batch_id, site_id)
        self._ensure_site_batch_can_be_edited_in_office(batch)
        item = self.db.get(SiteMeasurementItem, measurement_item_id)
        if (
            item is None
            or item.site_id != site_id
            or item.measurement_batch_id != batch.id
            or item.is_hidden
            or not item.is_free_position
        ):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Manuelle Aufmaßposition nicht gefunden.")

        measurement_base_ids = self._measurement_catalog_base_ids(batch)
        position_was_submitted = "position" in payload.model_fields_set
        link_was_submitted = "linked_measurement_item_id" in payload.model_fields_set
        linked_measurement_item = None
        if (
            link_was_submitted
            and payload.linked_measurement_item_id is not None
        ):
            linked_measurement_item = self._get_measurement_catalog_item(
                site_id=site_id,
                measurement_item_id=payload.linked_measurement_item_id,
                measurement_base_ids=measurement_base_ids,
            )
        elif position_was_submitted and payload.position:
            linked_measurement_item = self._find_measurement_catalog_item_by_position(
                site_id=site_id,
                position=payload.position,
                measurement_base_ids=measurement_base_ids,
            )

        if linked_measurement_item is not None:
            # The target only defines the billing position.  The free item remains a
            # distinct matrix column with its original worker description, unit and
            # entries so review and PDF totals keep using the concrete item id.
            item.linked_measurement_item_id = linked_measurement_item.id
            item.position = linked_measurement_item.position
        elif position_was_submitted:
            position = payload.position.strip() if payload.position else ""
            if position:
                position_scope = [
                    SiteMeasurementItem.site_id == batch.site_id,
                    SiteMeasurementItem.id != item.id,
                ]
                if batch.position_mode == MeasurementPositionMode.BLANK.value:
                    position_scope.append(SiteMeasurementItem.measurement_batch_id == batch.id)
                else:
                    position_scope.append(
                        SiteMeasurementItem.measurement_base_id == batch.measurement_base_id
                    )
                existing_position = self.db.scalar(
                    select(SiteMeasurementItem.id).where(
                        *position_scope,
                        func.lower(SiteMeasurementItem.position) == position.lower(),
                    )
                )
                if existing_position is not None:
                    raise HTTPException(
                        status.HTTP_409_CONFLICT,
                        "Diese Positionsnummer existiert in diesem Aufmaß bereits.",
                    )
                item.position = position
            elif not _is_technical_free_measurement_position(item.position):
                item.position = self._next_free_measurement_position(batch, exclude_item_id=item.id)

            item.linked_measurement_item_id = None
        elif link_was_submitted and payload.linked_measurement_item_id is None:
            item.linked_measurement_item_id = None
            if not _is_technical_free_measurement_position(item.position):
                item.position = self._next_free_measurement_position(batch, exclude_item_id=item.id)

        if linked_measurement_item is None and payload.description is not None:
            description = " ".join(payload.description.split())
            if not description and batch.position_mode != MeasurementPositionMode.BLANK.value:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "Kurztext ist erforderlich.")
            item.description = description
        if linked_measurement_item is None and payload.unit is not None:
            unit = payload.unit.strip()
            if not unit and batch.position_mode != MeasurementPositionMode.BLANK.value:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "Einheit ist erforderlich.")
            item.unit = unit
        self.db.commit()
        self.db.refresh(item)
        return self._build_mobile_item(item, batch.id)

    def delete_site_free_item(
        self,
        *,
        site_id: int,
        batch_id: int,
        measurement_item_id: int,
    ) -> None:
        self._get_site(site_id)
        batch = self._get_batch_for_site(batch_id, site_id)
        item = self.db.get(SiteMeasurementItem, measurement_item_id)
        if (
            batch.position_mode != MeasurementPositionMode.BLANK.value
            or item is None
            or item.site_id != site_id
            or item.measurement_batch_id != batch.id
            or item.is_hidden
            or not item.is_free_position
        ):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Manuelle Aufmaßposition nicht gefunden.")
        self.db.delete(item)
        self.db.commit()

    def hide_item(self, *, site_id: int, measurement_item_id: int) -> MeasurementItemRead:
        self._get_site(site_id)
        item = self.db.scalar(
            select(SiteMeasurementItem).where(
                SiteMeasurementItem.id == measurement_item_id,
                SiteMeasurementItem.site_id == site_id,
            )
        )
        if item is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Aufmaßposition nicht gefunden.")
        if not item.is_hidden:
            item.is_hidden = True
            self.db.commit()
            self.db.refresh(item)
        return MeasurementItemRead.model_validate(item)

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
        if item is None or not self._measurement_item_is_available_for_batch(
            batch=batch,
            item=item,
        ):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Aufmaßposition nicht gefunden.")

        comment = payload.area_or_comment.strip()
        if not comment:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Bereich oder Kommentar ist erforderlich.")

        self._delete_existing_entries_for_cell(
            batch_id=batch.id,
            measurement_item_id=item.id,
            area_or_comment=comment,
        )
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

    def create_mobile_free_item(
        self,
        *,
        assignment_id: int,
        batch_id: int,
        current_user: User,
        payload: MobileMeasurementFreeItemCreate,
    ) -> MobileMeasurementItemRead:
        assignment = self._get_user_assignment(assignment_id, current_user)
        batch = self._get_batch_for_site(batch_id, assignment.site_id)
        if batch.status != "draft":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Dieses Aufmaß wurde bereits zur Prüfung gesendet.",
            )
        self._ensure_mobile_batch_can_be_edited_by_worker(batch)

        description = " ".join(payload.description.split())
        unit = payload.unit.strip()
        if not description:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Kurztext ist erforderlich.")
        if not unit:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Einheit ist erforderlich.")
        position = payload.position.strip() if payload.position else ""
        if position:
            existing_position = self.db.scalar(
                select(SiteMeasurementItem.id).where(
                    SiteMeasurementItem.site_id == batch.site_id,
                    SiteMeasurementItem.measurement_base_id == batch.measurement_base_id,
                    func.lower(SiteMeasurementItem.position) == position.lower(),
                )
            )
            if existing_position is not None:
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    "Diese Positionsnummer existiert in diesem Aufmaß bereits.",
                )
        else:
            position = self._next_free_measurement_position(batch)

        next_sort_order = (
            self.db.scalar(
                select(func.max(SiteMeasurementItem.sort_order)).where(
                    SiteMeasurementItem.site_id == batch.site_id,
                    SiteMeasurementItem.measurement_base_id == batch.measurement_base_id,
                )
            )
            or 0
        ) + 10

        item = SiteMeasurementItem(
            site_id=batch.site_id,
            measurement_base_id=batch.measurement_base_id,
            measurement_batch_id=batch.id,
            source_file_name=None,
            source_project_number=None,
            source_invoice_number=None,
            source_customer_name=None,
            position=position,
            description=description,
            list_quantity=None,
            unit=unit,
            minutes_per_unit=None,
            list_minutes_total=None,
            is_nep=False,
            is_free_position=True,
            sort_order=next_sort_order,
        )
        self.db.add(item)
        self.db.flush()

        if payload.quantity != 0 or payload.area_or_comment is not None:
            comment = " ".join((payload.area_or_comment or "").split()) or "Allgemein"
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
        self.db.refresh(item)
        return self._build_mobile_item(item, batch.id)

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
        current_entries = _current_measurement_entries(list(batch.entries))
        if not current_entries:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Ein Aufmaß ohne Aufmaßzeilen kann nicht gesendet werden.",
            )

        for entry in current_entries:
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
        return self._build_mobile_batch(batch, current_user=current_user)

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
        if not self._batch_has_measurement_content(batch):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Ein Aufmaß ohne Aufmaßzeilen kann nicht unterschrieben werden.",
            )

        customer_name = " ".join(payload.customer_name.split())
        if not customer_name:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Kundenname ist erforderlich.")

        signed_at = datetime.now(timezone.utc)
        site = self._get_site(assignment.site_id)
        batch.customer_signature_name = customer_name
        batch.customer_signature_place = format_site_signature_location(site)
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
        return self._build_mobile_batch(batch, current_user=current_user)

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
        if batch.status in {"billed", "approved", "closed"}:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Dieses Aufmaß ist bereits abgeschlossen.",
            )
        if not _current_measurement_entries(list(batch.entries)):
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
        return self._build_mobile_batch(batch, current_user=current_user)

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
        current_photo_count = self.db.scalar(
            select(func.count(SiteMeasurementBatchPhoto.id)).where(
                SiteMeasurementBatchPhoto.measurement_batch_id == batch.id
            )
        ) or 0
        if current_photo_count >= MAX_DOCUMENT_PHOTOS:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Maximal 5 Fotos erlaubt.")
        normalized_content_type = _normalize_content_type(content_type)
        if normalized_content_type not in MEASUREMENT_PHOTO_CONTENT_TYPES:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Bitte ein Foto als JPEG, PNG, WebP oder HEIC hochladen.",
            )
        optimized_photo = optimize_document_photo(content)
        LOGGER.info(
            "Measurement photo optimized: batch_id=%s bytes=%s->%s dimensions=%sx%s->%sx%s duration_ms=%.1f",
            batch.id,
            optimized_photo.original_size_bytes,
            optimized_photo.optimized_size_bytes,
            optimized_photo.original_width,
            optimized_photo.original_height,
            optimized_photo.optimized_width,
            optimized_photo.optimized_height,
            optimized_photo.duration_ms,
        )

        folder = ProjectFolderService(self.db).get_project_folder_for_site_by_key(
            assignment.site_id,
            MEASUREMENT_PHOTO_FOLDER_KEY,
            current_user,
        )
        existing_photo_names = set(
            self.db.scalars(
                select(SiteMeasurementBatchPhoto.filename).where(
                    SiteMeasurementBatchPhoto.measurement_batch_id == batch.id
                )
            ).all()
        )
        upload_filename = build_photo_filename(
            site_name=batch.site.name if batch.site else "Baustelle",
            document_label=measurement_photo_document_label(batch),
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

        photo = SiteMeasurementBatchPhoto(
            site_id=batch.site_id,
            measurement_batch_id=batch.id,
            uploaded_by_user_id=current_user.id,
            project_folder_key=MEASUREMENT_PHOTO_FOLDER_KEY,
            external_drive_id=folder.external_drive_id or "",
            external_item_id=item_id,
            external_web_url=uploaded.get("web_url"),
            filename=str(uploaded.get("name") or upload_filename),
            content_type=optimized_photo.content_type,
            file_size_bytes=uploaded.get("size") if isinstance(uploaded.get("size"), int) else len(optimized_photo.content),
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

    def update_mobile_batch_photo_caption(
        self,
        *,
        assignment_id: int,
        batch_id: int,
        photo_id: int,
        caption: str | None,
        current_user: User,
    ) -> MobileMeasurementBatchPhotoRead:
        assignment = self._get_user_assignment(assignment_id, current_user)
        batch = self._get_batch_for_site(batch_id, assignment.site_id)
        self._ensure_mobile_batch_can_be_edited_by_worker(batch)
        photo = self._get_photo_for_batch(photo_id, batch.id)
        photo.caption = caption
        self.db.commit()
        self.db.refresh(photo)
        return self._build_mobile_photo(photo)

    def list_site_batches(
        self,
        site_id: int,
        measurement_base_id: int | None = None,
        active_only: bool = False,
        archived_only: bool = False,
    ) -> list[MobileMeasurementBatchRead]:
        self._get_site(site_id)
        active_base_id = self._get_active_measurement_base_id(site_id)
        if active_only and not archived_only:
            measurement_base_id = active_base_id
            if measurement_base_id is None:
                return []
        statement = (
            select(SiteMeasurementBatch)
            .options(
                selectinload(SiteMeasurementBatch.entries).selectinload(
                    SiteMeasurementEntry.measurement_item
                ),
                selectinload(SiteMeasurementBatch.free_items),
                selectinload(SiteMeasurementBatch.measurement_base),
                selectinload(SiteMeasurementBatch.created_by).selectinload(User.person),
                selectinload(SiteMeasurementBatch.submitted_by).selectinload(User.person),
                selectinload(SiteMeasurementBatch.deleted_by).selectinload(User.person),
                selectinload(SiteMeasurementBatch.assigned_employee),
                selectinload(SiteMeasurementBatch.area_rows),
            )
            .where(SiteMeasurementBatch.site_id == site_id)
        )
        if archived_only:
            statement = statement.where(SiteMeasurementBatch.deleted_at.is_not(None))
        else:
            statement = statement.where(SiteMeasurementBatch.deleted_at.is_(None))
        if measurement_base_id is not None:
            statement = statement.where(SiteMeasurementBatch.measurement_base_id == measurement_base_id)
        batches = list(
            self.db.scalars(
                statement.order_by(SiteMeasurementBatch.number, SiteMeasurementBatch.id)
            ).all()
        )
        customer_email_statuses = self._latest_customer_email_statuses(
            entity_type="measurement_batch",
            action="measurement.email_sent",
            entity_ids=[batch.id for batch in batches],
        )
        photo_counts = self._photo_counts_by_batch_id(batch_ids=[batch.id for batch in batches])
        calculation_lookup = self._measurement_calculation_lookup(site_id)
        return [
            self._build_mobile_batch(
                batch,
                active_base_id=active_base_id,
                customer_email_status=customer_email_statuses.get(batch.id),
                photo_count=photo_counts.get(batch.id, 0),
                calculation_lookup=calculation_lookup,
            )
            for batch in batches
        ]

    def list_site_batch_items(
        self, *, site_id: int, batch_id: int
    ) -> list[MobileMeasurementItemRead]:
        self._get_site(site_id)
        batch = self._get_batch_for_site(batch_id, site_id)
        items = self._list_batch_position_items(batch)
        return [self._build_mobile_item(item, batch.id) for item in items]

    def delete_site_batch(self, *, site_id: int, batch_id: int, current_user: User) -> None:
        self._get_site(site_id)
        batch = self._get_batch_for_site(batch_id, site_id)
        batch.deleted_at = datetime.now(timezone.utc)
        batch.deleted_by_user_id = current_user.id
        self.db.commit()

    def restore_site_batch(
        self,
        *,
        site_id: int,
        batch_id: int,
    ) -> MobileMeasurementBatchRead:
        self._get_site(site_id)
        batch = self._get_batch_for_site(batch_id, site_id, include_deleted=True)
        if batch.deleted_at is None:
            return self._build_mobile_batch(
                batch,
                active_base_id=self._get_active_measurement_base_id(site_id),
                photo_count=self._photo_count_for_batch(batch.id),
            )
        batch.deleted_at = None
        batch.deleted_by_user_id = None
        batch.deleted_by = None
        self.db.commit()
        self.db.refresh(batch)
        return self._build_mobile_batch(
            batch,
            active_base_id=self._get_active_measurement_base_id(site_id),
            photo_count=self._photo_count_for_batch(batch.id),
        )

    def get_site_measurement_timesheet(self, site_id: int) -> MeasurementTimesheetRead:
        self._get_site(site_id)
        completed_batch_ids = list(
            self.db.scalars(
                select(SiteMeasurementBatch.id)
                .where(
                    SiteMeasurementBatch.site_id == site_id,
                    SiteMeasurementBatch.status.in_(MEASUREMENT_COMPLETED_BATCH_STATUSES),
                    SiteMeasurementBatch.deleted_at.is_(None),
                )
                .order_by(SiteMeasurementBatch.number, SiteMeasurementBatch.id)
            ).all()
        )
        completed_entries: list[SiteMeasurementEntry] = []
        if completed_batch_ids:
            completed_entries = _current_measurement_entries(list(
                self.db.scalars(
                    select(SiteMeasurementEntry)
                    .options(selectinload(SiteMeasurementEntry.measurement_item))
                    .where(
                        SiteMeasurementEntry.site_id == site_id,
                        SiteMeasurementEntry.measurement_batch_id.in_(completed_batch_ids),
                    )
                ).all()
            ))
        calculation_lookup = self._measurement_calculation_lookup(site_id)
        billed_minutes, missing_billed_item_ids = self._sum_reported_minutes_with_missing(
            completed_entries,
            calculation_lookup=calculation_lookup,
        )
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
                    billed_minutes=billed_minutes,
                    billed_missing_position_count=len(missing_billed_item_ids),
                    completed_batch_count=len(completed_batch_ids),
                    open_minutes=None,
                    progress_percent=None,
                    captured_count=0,
                    not_captured_count=0,
                    has_planned_basis=False,
                ),
                rows=[],
            )

        active_base = self.db.get(SiteMeasurementBase, active_base_id)
        items = list(
            self.db.scalars(
                select(SiteMeasurementItem)
                .where(
                    SiteMeasurementItem.site_id == site_id,
                    SiteMeasurementItem.measurement_base_id == active_base_id,
                    SiteMeasurementItem.is_hidden.is_(False),
                )
                .order_by(SiteMeasurementItem.sort_order, SiteMeasurementItem.id)
            ).all()
        )
        target_item_ids = {item.id for item in items}
        target_ids_by_position: dict[str, list[int]] = {}
        for item in items:
            position_key = _measurement_position_key(item.position)
            if position_key:
                target_ids_by_position.setdefault(position_key, []).append(item.id)
        unique_target_id_by_position = {
            position_key: item_ids[0]
            for position_key, item_ids in target_ids_by_position.items()
            if len(item_ids) == 1
        }
        measured_by_item_id: dict[int, Decimal] = {}
        captured_item_ids: set[int] = set()
        if completed_entries:
            for entry in completed_entries:
                source_item = entry.measurement_item
                if source_item is None or source_item.is_hidden:
                    continue
                target_item_id = (
                    source_item.linked_measurement_item_id
                    if source_item.linked_measurement_item_id in target_item_ids
                    else (
                        source_item.id
                        if source_item.id in target_item_ids
                        else unique_target_id_by_position.get(
                            _measurement_position_key(source_item.position)
                        )
                    )
                )
                if target_item_id is None:
                    continue
                captured_item_ids.add(target_item_id)
                measured_by_item_id[target_item_id] = (
                    measured_by_item_id.get(target_item_id, Decimal("0")) + entry.quantity
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
                if minutes_per_unit > 0
                else Decimal("0")
            )
            remaining_quantity = planned_quantity - measured_quantity if planned_quantity > 0 else None
            progress_percent = (
                float((measured_minutes / planned_minutes) * Decimal("100"))
                if planned_minutes > 0
                else None
            )
            is_captured = item.id in captured_item_ids

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
            active_batch_ids=completed_batch_ids,
            active_measurement_label=active_base.name if active_base else None,
            last_import_label=latest_import_item.source_file_name if latest_import_item else None,
            last_import_at=latest_import_timestamp,
            kpi=MeasurementTimesheetKpiRead(
                position_count=len(rows),
                planned_minutes=planned_minutes_total,
                measured_minutes=measured_minutes_total,
                billed_minutes=billed_minutes,
                billed_missing_position_count=len(missing_billed_item_ids),
                completed_batch_count=len(completed_batch_ids),
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

    def get_site_measurement_time_analysis(self, site_id: int) -> MeasurementTimeAnalysisRead:
        self._get_site(site_id)
        batches = list(
            self.db.scalars(
                select(SiteMeasurementBatch)
                .options(
                    selectinload(SiteMeasurementBatch.entries).selectinload(
                        SiteMeasurementEntry.measurement_item
                    ),
                    selectinload(SiteMeasurementBatch.measurement_base),
                )
                .where(SiteMeasurementBatch.site_id == site_id)
                .where(SiteMeasurementBatch.deleted_at.is_(None))
                .where(SiteMeasurementBatch.status != "draft")
            ).all()
        )
        batches.sort(key=lambda batch: self._analysis_timestamp(batch) or datetime.min)

        rows: list[MeasurementTimeAnalysisRowRead] = []
        if not batches:
            return MeasurementTimeAnalysisRead(
                site_id=site_id,
                totals=MeasurementTimeAnalysisTotalsRead(
                    planned_minutes=Decimal("0"),
                    actual_minutes=Decimal("0"),
                    deviation_minutes=Decimal("0"),
                    consumption_percent=None,
                ),
                rows=[],
            )

        work_entries = list(
            self.db.scalars(
                select(WorkTimeEntry)
                .where(WorkTimeEntry.site_id == site_id)
                .order_by(WorkTimeEntry.work_date, WorkTimeEntry.id)
            ).all()
        )
        time_entry_service = TimeEntryService(self.db)
        relevant_work_entries = [
            entry for entry in work_entries if TimeEntryService.is_project_mounting_time_relevant(entry)
        ]
        project_mounting_contexts = time_entry_service.project_mounting_contexts(relevant_work_entries)
        calculation_lookup = self._measurement_calculation_lookup(site_id)

        previous_boundary: datetime | None = None
        row_payloads: list[dict[str, object]] = []
        for batch in batches:
            analysis_at = self._analysis_timestamp(batch)
            boundary = self._local_analysis_datetime(analysis_at) if analysis_at else None
            measurement_minutes = self._sum_reported_minutes(
                _current_measurement_entries(list(batch.entries)),
                calculation_lookup=calculation_lookup,
            ) or Decimal("0")
            actual_minutes = self._sum_work_minutes_for_period(
                relevant_work_entries,
                period_start=previous_boundary,
                period_end=boundary,
                project_mounting_contexts=project_mounting_contexts,
            )
            row_payloads.append(
                {
                    "batch": batch,
                    "analysis_at": analysis_at,
                    "boundary": boundary,
                    "measurement_minutes": measurement_minutes,
                    "actual_minutes": actual_minutes,
                    "extra_work_tickets": [],
                    "extra_work_minutes": Decimal("0"),
                    "period_start": previous_boundary,
                    "period_end": boundary,
                }
            )
            previous_boundary = boundary

        tickets = list(
            self.db.scalars(
                select(ExtraWorkTicket)
                .options(selectinload(ExtraWorkTicket.entries))
                .where(
                    ExtraWorkTicket.site_id == site_id,
                    ExtraWorkTicket.deleted_at.is_(None),
                )
                .where(ExtraWorkTicket.status != "draft")
                .order_by(ExtraWorkTicket.sequence_number, ExtraWorkTicket.id)
            ).all()
        )
        for ticket in tickets:
            ticket_minutes = self._extra_work_ticket_planned_minutes(ticket)
            ticket_read = MeasurementTimeAnalysisExtraWorkTicketRead(
                id=ticket.id,
                display_number=ticket.display_number,
                title=ticket.title,
                status=ticket.status,
                relevant_at=self._extra_work_ticket_timestamp(ticket),
                planned_minutes=ticket_minutes,
            )
            row_index = self._find_analysis_row_index(row_payloads, ticket_read.relevant_at)
            row_payloads[row_index]["extra_work_tickets"].append(ticket_read)
            row_payloads[row_index]["extra_work_minutes"] = (
                row_payloads[row_index]["extra_work_minutes"] + ticket_minutes
            )

        planned_total = Decimal("0")
        actual_total = Decimal("0")
        for payload in row_payloads:
            batch = payload["batch"]
            measurement_minutes = payload["measurement_minutes"]
            extra_work_minutes = payload["extra_work_minutes"]
            planned_minutes = measurement_minutes + extra_work_minutes
            actual_minutes = payload["actual_minutes"]
            deviation_minutes = planned_minutes - actual_minutes
            planned_total += planned_minutes
            actual_total += actual_minutes
            rows.append(
                MeasurementTimeAnalysisRowRead(
                    measurement_batch_id=batch.id,
                    measurement_number=batch.number,
                    measurement_title=batch.title,
                    measurement_status=batch.status,
                    analysis_at=payload["analysis_at"],
                    period_start=payload["period_start"],
                    period_end=payload["period_end"],
                    measurement_minutes=measurement_minutes,
                    extra_work_minutes=extra_work_minutes,
                    planned_minutes=planned_minutes,
                    actual_minutes=actual_minutes,
                    deviation_minutes=deviation_minutes,
                    consumption_percent=(
                        float((actual_minutes / planned_minutes) * Decimal("100"))
                        if planned_minutes > 0
                        else None
                    ),
                    extra_work_tickets=payload["extra_work_tickets"],
                )
            )

        deviation_total = planned_total - actual_total
        return MeasurementTimeAnalysisRead(
            site_id=site_id,
            totals=MeasurementTimeAnalysisTotalsRead(
                planned_minutes=planned_total,
                actual_minutes=actual_total,
                deviation_minutes=deviation_total,
                consumption_percent=(
                    float((actual_total / planned_total) * Decimal("100"))
                    if planned_total > 0
                    else None
                ),
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
        batch.status = normalized_status
        for entry in _current_measurement_entries(list(batch.entries)):
            entry.status = normalized_status
        if normalized_status == "billed" and current_user is not None:
            self._archive_billed_batch_pdf(batch=batch, current_user=current_user)
        self.db.commit()
        self.db.refresh(batch)
        return self._build_mobile_batch(batch)

    def promote_site_batch_status(
        self,
        *,
        site_id: int,
        batch_id: int,
        target_status: str,
        current_user: User,
    ) -> MobileMeasurementBatchRead:
        self._get_site(site_id)
        batch = self._get_batch_for_site(batch_id, site_id, for_update=True)
        previous_status = batch.status
        target_status = validate_measurement_status_promotion(previous_status, target_status)
        AuditService(self.db).record(
            user_id=current_user.id,
            action="measurement.status_promoted",
            entity_type="site_measurement_batch",
            entity_id=batch.id,
            old_value={"status": previous_status},
            new_value={"status": target_status},
        )
        if target_status == "reviewed":
            return self.set_site_batch_reviewed(site_id=site_id, batch_id=batch_id)
        return self.set_site_batch_billing_status(
            site_id=site_id,
            batch_id=batch_id,
            billing_status=target_status,
            current_user=current_user,
        )

    def set_site_batch_reviewed(
        self, *, site_id: int, batch_id: int
    ) -> MobileMeasurementBatchRead:
        self._get_site(site_id)
        batch = self._get_batch_for_site(batch_id, site_id)
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
        previous_status = batch.status
        notification_user_id = (
            batch.submitted_by_user_id
            or batch.created_by_user_id
            or next((entry.created_by_user_id for entry in _current_measurement_entries(list(batch.entries)) if entry.created_by_user_id), None)
        )
        entry_author_user_ids = sorted(
            {entry.created_by_user_id for entry in _current_measurement_entries(list(batch.entries)) if entry.created_by_user_id is not None}
        )
        LOGGER.info(
            "Measurement reviewed trigger fired: site_id=%s batch_id=%s previous_status=%s submitted_by_user_id=%s created_by_user_id=%s entry_author_user_ids=%s recipient_user_id=%s.",
            site_id,
            batch.id,
            previous_status,
            batch.submitted_by_user_id,
            batch.created_by_user_id,
            entry_author_user_ids,
            notification_user_id,
        )

        batch.status = "reviewed"
        for entry in _current_measurement_entries(list(batch.entries)):
            entry.status = "reviewed"
        self.db.commit()
        self.db.refresh(batch)
        if previous_status != "reviewed" and batch.origin != MeasurementBatchOrigin.OFFICE.value:
            try:
                PushNotificationService(self.db).send_measurement_reviewed(
                    user_id=notification_user_id,
                    site_id=site_id,
                    batch_id=batch.id,
                )
            except Exception:
                LOGGER.exception(
                    "Measurement reviewed push failed: site_id=%s batch_id=%s user_id=%s",
                    site_id,
                    batch.id,
                    notification_user_id,
                )
        else:
            LOGGER.info(
                "Measurement reviewed push skipped: batch already reviewed (site_id=%s batch_id=%s user_id=%s).",
                site_id,
                batch.id,
                notification_user_id,
            )
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
        if batch.status == "draft" and batch.origin != MeasurementBatchOrigin.OFFICE.value:
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

        entries = _current_measurement_entries(list(batch.entries))
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
        self, *, limit: int = 6, current_user: User | None = None
    ) -> list[MeasurementDashboardSubmissionRead]:
        dismissed_keys = self._dashboard_dismissed_keys(current_user)

        statement = (
            select(SiteMeasurementBatch)
            .join(SiteMeasurementBatch.site)
            .options(
                selectinload(SiteMeasurementBatch.site),
                selectinload(SiteMeasurementBatch.entries),
                selectinload(SiteMeasurementBatch.submitted_by).selectinload(User.person),
            )
            .where(
                SiteMeasurementBatch.status.notin_(("billed", "approved", "closed")),
                SiteMeasurementBatch.deleted_at.is_(None),
                or_(
                    SiteMeasurementBatch.status.in_(("submitted", "rejected")),
                    SiteMeasurementBatch.customer_signed_at.is_not(None),
                ),
            )
        )
        if current_user is not None and current_user.role == UserRole.PROJECT_MANAGER:
            statement = statement.where(Site.project_manager_person_id == current_user.person_id)

        batches = list(
            self.db.scalars(
                statement.order_by(
                    func.coalesce(
                        SiteMeasurementBatch.customer_signed_at,
                        SiteMeasurementBatch.submitted_at,
                        SiteMeasurementBatch.updated_at,
                    ).desc(),
                    SiteMeasurementBatch.updated_at.desc(),
                ).limit(limit + len(dismissed_keys))
            ).all()
        )
        extra_work_statement = (
            select(ExtraWorkTicket)
            .join(ExtraWorkTicket.site)
            .options(
                selectinload(ExtraWorkTicket.site),
                selectinload(ExtraWorkTicket.entries),
                selectinload(ExtraWorkTicket.submitted_by).selectinload(User.person),
            )
            .where(
                ExtraWorkTicket.status == "submitted",
                ExtraWorkTicket.submitted_at.is_not(None),
                ExtraWorkTicket.deleted_at.is_(None),
            )
        )
        if current_user is not None and current_user.role == UserRole.PROJECT_MANAGER:
            extra_work_statement = extra_work_statement.where(
                Site.project_manager_person_id == current_user.person_id
            )

        extra_work_tickets = list(
            self.db.scalars(
                extra_work_statement.order_by(
                    ExtraWorkTicket.submitted_at.desc(),
                    ExtraWorkTicket.updated_at.desc(),
                ).limit(limit + len(dismissed_keys))
            ).all()
        )
        messages: list[MeasurementDashboardSubmissionRead] = []
        for batch in batches:
            message = self._build_dashboard_submission(batch)
            if message.message_key in dismissed_keys:
                continue
            messages.append(message)
        for ticket in extra_work_tickets:
            message = self._build_extra_work_dashboard_submission(ticket)
            if message.message_key in dismissed_keys:
                continue
            messages.append(message)
        return sorted(
            messages,
            key=lambda message: message.event_at or message.submitted_at or datetime.min.replace(tzinfo=timezone.utc),
            reverse=True,
        )[:limit]

    def get_dashboard_messages_summary(
        self, *, limit: int = 6, current_user: User | None = None
    ) -> DashboardMessagesSummaryRead:
        return DashboardMessagesSummaryRead(
            open_count=self.count_dashboard_submissions(current_user=current_user),
            latest_messages=[
                DashboardMessageRead.model_validate(message.model_dump())
                for message in self.list_dashboard_submissions(
                    limit=limit,
                    current_user=current_user,
                )
            ],
        )

    def count_dashboard_submissions(self, *, current_user: User | None = None) -> int:
        dismissed_ids = self._dashboard_dismissed_ids_by_type(current_user)
        batch_base_filters = [
            SiteMeasurementBatch.status.notin_(("billed", "approved", "closed")),
        ]
        if current_user is not None and current_user.role == UserRole.PROJECT_MANAGER:
            batch_base_filters.append(Site.project_manager_person_id == current_user.person_id)

        submitted_batch_filters = [
            *batch_base_filters,
            SiteMeasurementBatch.customer_signed_at.is_(None),
            SiteMeasurementBatch.status.in_(("submitted", "rejected")),
        ]
        submitted_batch_dismissed_ids = dismissed_ids.get("measurement_submitted", set())
        if submitted_batch_dismissed_ids:
            submitted_batch_filters.append(SiteMeasurementBatch.id.notin_(submitted_batch_dismissed_ids))
        submitted_batch_count = self.db.scalar(
            select(func.count(SiteMeasurementBatch.id))
            .join(SiteMeasurementBatch.site)
            .where(*submitted_batch_filters)
        ) or 0

        signed_batch_filters = [
            *batch_base_filters,
            SiteMeasurementBatch.customer_signed_at.is_not(None),
        ]
        signed_batch_dismissed_ids = dismissed_ids.get("measurement_customer_signed", set())
        if signed_batch_dismissed_ids:
            signed_batch_filters.append(SiteMeasurementBatch.id.notin_(signed_batch_dismissed_ids))
        signed_batch_count = self.db.scalar(
            select(func.count(SiteMeasurementBatch.id))
            .join(SiteMeasurementBatch.site)
            .where(*signed_batch_filters)
        ) or 0

        extra_work_filters = [
            ExtraWorkTicket.status == "submitted",
            ExtraWorkTicket.submitted_at.is_not(None),
            ExtraWorkTicket.deleted_at.is_(None),
        ]
        if current_user is not None and current_user.role == UserRole.PROJECT_MANAGER:
            extra_work_filters.append(Site.project_manager_person_id == current_user.person_id)
        extra_work_dismissed_ids = dismissed_ids.get("extra_work_submitted", set())
        if extra_work_dismissed_ids:
            extra_work_filters.append(ExtraWorkTicket.id.notin_(extra_work_dismissed_ids))
        extra_work_count = self.db.scalar(
            select(func.count(ExtraWorkTicket.id))
            .join(ExtraWorkTicket.site)
            .where(*extra_work_filters)
        ) or 0

        return submitted_batch_count + signed_batch_count + extra_work_count

    def dismiss_dashboard_message(self, *, message_key: str, current_user: User) -> None:
        message_type = message_key.split(":", 1)[0].strip()
        if not message_type or not message_key.strip():
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Ungültige Meldung.")
        existing = self.db.scalar(
            select(DashboardMessageDismissal).where(
                DashboardMessageDismissal.user_id == current_user.id,
                DashboardMessageDismissal.message_key == message_key,
            )
        )
        if existing is not None:
            return
        self.db.add(
            DashboardMessageDismissal(
                user_id=current_user.id,
                message_type=message_type,
                message_key=message_key,
            )
        )
        self.db.commit()

    def _dashboard_dismissed_keys(self, current_user: User | None) -> set[str]:
        if current_user is None:
            return set()
        return set(
            self.db.scalars(
                select(DashboardMessageDismissal.message_key).where(
                    DashboardMessageDismissal.user_id == current_user.id,
                    DashboardMessageDismissal.message_type.in_(
                        ("measurement_submitted", "measurement_customer_signed", "extra_work_submitted")
                    ),
                )
            ).all()
        )

    def _dashboard_dismissed_ids_by_type(self, current_user: User | None) -> dict[str, set[int]]:
        dismissed_ids: dict[str, set[int]] = {
            "measurement_submitted": set(),
            "measurement_customer_signed": set(),
            "extra_work_submitted": set(),
        }
        for message_key in self._dashboard_dismissed_keys(current_user):
            message_type, _, raw_id = message_key.partition(":")
            if message_type in dismissed_ids and raw_id.isdigit():
                dismissed_ids[message_type].add(int(raw_id))
        return dismissed_ids

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
                source_section_key=item.source_section_key,
                source_section_title=item.source_section_title,
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

    def _get_batch_for_site(
        self,
        batch_id: int,
        site_id: int,
        *,
        include_deleted: bool = False,
        for_update: bool = False,
    ) -> SiteMeasurementBatch:
        statement = (
            select(SiteMeasurementBatch)
            .options(
                selectinload(SiteMeasurementBatch.entries).selectinload(
                    SiteMeasurementEntry.measurement_item
                ),
                selectinload(SiteMeasurementBatch.area_rows),
                selectinload(SiteMeasurementBatch.free_items),
                selectinload(SiteMeasurementBatch.photos),
                selectinload(SiteMeasurementBatch.created_by).selectinload(User.person),
                selectinload(SiteMeasurementBatch.submitted_by).selectinload(User.person),
                selectinload(SiteMeasurementBatch.deleted_by).selectinload(User.person),
                selectinload(SiteMeasurementBatch.measurement_base),
                selectinload(SiteMeasurementBatch.assigned_employee),
            )
            .where(SiteMeasurementBatch.id == batch_id, SiteMeasurementBatch.site_id == site_id)
        )
        if not include_deleted:
            statement = statement.where(SiteMeasurementBatch.deleted_at.is_(None))
        if for_update:
            statement = statement.with_for_update()
        batch = self.db.scalar(
            statement
        )
        if batch is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Aufmaß nicht gefunden.")
        return batch

    def _measurement_catalog_base_ids(self, batch: SiteMeasurementBatch) -> tuple[int, ...]:
        """Return the persisted and currently released offer bases for a batch."""
        base_ids: list[int] = []
        if batch.measurement_base_id is not None:
            base_ids.append(batch.measurement_base_id)
        active_base_id = self._get_active_measurement_base_id(batch.site_id)
        if active_base_id is not None and active_base_id not in base_ids:
            base_ids.append(active_base_id)
        return tuple(base_ids)

    def _list_batch_position_items(
        self,
        batch: SiteMeasurementBatch,
    ) -> list[SiteMeasurementItem]:
        """Load persisted rows plus the selectable catalog for an offer-based batch."""
        common_filters = [
            SiteMeasurementItem.site_id == batch.site_id,
            SiteMeasurementItem.is_hidden.is_(False),
        ]
        if batch.position_mode == MeasurementPositionMode.BLANK.value:
            statement = select(SiteMeasurementItem).where(
                *common_filters,
                SiteMeasurementItem.measurement_batch_id == batch.id,
                SiteMeasurementItem.is_free_position.is_(True),
            )
            return list(
                self.db.scalars(
                    statement.options(
                        selectinload(SiteMeasurementItem.entries).selectinload(
                            SiteMeasurementEntry.created_by
                        ),
                        with_loader_criteria(
                            SiteMeasurementEntry,
                            SiteMeasurementEntry.measurement_batch_id == batch.id,
                            include_aliases=True,
                        ),
                    ).order_by(SiteMeasurementItem.sort_order, SiteMeasurementItem.id)
                ).all()
            )

        catalog_base_ids = self._measurement_catalog_base_ids(batch)
        batch_entry_item_ids = {entry.measurement_item_id for entry in batch.entries}
        batch_owned_item_ids = {item.id for item in batch.free_items}
        batch_specific_item_ids = batch_entry_item_ids | batch_owned_item_ids

        if catalog_base_ids:
            catalog_base_filter = SiteMeasurementItem.measurement_base_id.in_(catalog_base_ids)
        else:
            catalog_base_filter = SiteMeasurementItem.measurement_base_id.is_(None)

        catalog_filter = and_(
            catalog_base_filter,
            or_(
                SiteMeasurementItem.is_free_position.is_(False),
                SiteMeasurementItem.measurement_batch_id.is_(None),
                SiteMeasurementItem.measurement_batch_id == batch.id,
            ),
        )
        item_scopes = [catalog_filter]
        if batch_specific_item_ids:
            item_scopes.append(SiteMeasurementItem.id.in_(batch_specific_item_ids))

        items = list(
            self.db.scalars(
                select(SiteMeasurementItem)
                .options(
                    selectinload(SiteMeasurementItem.entries).selectinload(
                        SiteMeasurementEntry.created_by
                    ),
                    with_loader_criteria(
                        SiteMeasurementEntry,
                        SiteMeasurementEntry.measurement_batch_id == batch.id,
                        include_aliases=True,
                    ),
                )
                .where(*common_filters, or_(*item_scopes))
                .order_by(SiteMeasurementItem.sort_order, SiteMeasurementItem.id)
            ).all()
        )

        # Persisted batch items are always retained. A used non-free position from
        # the historical base suppresses the same normalized position in a copied
        # active base. Unlinked free positions deliberately do not suppress it.
        selected_ids = set(batch_specific_item_ids)
        claimed_position_keys = {
            _measurement_position_key(item.position)
            for item in items
            if item.id in batch_entry_item_ids and not item.is_free_position
        }
        claimed_position_keys.discard("")

        priority_by_base_id = {
            base_id: priority for priority, base_id in enumerate(catalog_base_ids)
        }
        catalog_items = sorted(
            (
                item
                for item in items
                if item.id not in batch_owned_item_ids
                and (
                    item.measurement_base_id in catalog_base_ids
                    or (not catalog_base_ids and item.measurement_base_id is None)
                )
            ),
            key=lambda item: (
                priority_by_base_id.get(item.measurement_base_id, len(catalog_base_ids)),
                item.sort_order,
                item.id,
            ),
        )
        selected_catalog_keys: set[str] = set()
        for item in catalog_items:
            position_key = _measurement_position_key(item.position)
            if position_key in claimed_position_keys:
                if item.id in batch_entry_item_ids:
                    selected_ids.add(item.id)
                continue
            if position_key and position_key in selected_catalog_keys:
                continue
            selected_ids.add(item.id)
            if position_key:
                selected_catalog_keys.add(position_key)

        return [item for item in items if item.id in selected_ids]

    def _measurement_item_is_available_for_batch(
        self,
        *,
        batch: SiteMeasurementBatch,
        item: SiteMeasurementItem,
    ) -> bool:
        if item.site_id != batch.site_id or item.is_hidden:
            return False
        if batch.position_mode == MeasurementPositionMode.BLANK.value:
            return bool(item.measurement_batch_id == batch.id and item.is_free_position)
        if item.measurement_batch_id == batch.id:
            return True
        if any(entry.measurement_item_id == item.id for entry in batch.entries):
            return True
        return bool(
            item.measurement_base_id in self._measurement_catalog_base_ids(batch)
            and (not item.is_free_position or item.measurement_batch_id is None)
        )

    def _get_measurement_catalog_item(
        self,
        *,
        site_id: int,
        measurement_item_id: int | None,
        measurement_base_ids: tuple[int, ...],
    ) -> SiteMeasurementItem | None:
        if measurement_item_id is None:
            return None
        filters = [
            SiteMeasurementItem.id == measurement_item_id,
            SiteMeasurementItem.site_id == site_id,
            SiteMeasurementItem.measurement_base_id.is_not(None),
            SiteMeasurementItem.measurement_batch_id.is_(None),
            SiteMeasurementItem.is_free_position.is_(False),
            SiteMeasurementItem.is_hidden.is_(False),
        ]
        if measurement_base_ids:
            filters.append(SiteMeasurementItem.measurement_base_id.in_(measurement_base_ids))
        item = self.db.scalar(select(SiteMeasurementItem).where(*filters))
        if item is None:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Die verknüpfte Projektposition gehört nicht zum Positionskatalog dieses Aufmaßes.",
            )
        return item

    def _find_measurement_catalog_item_by_position(
        self,
        *,
        site_id: int,
        position: str,
        measurement_base_ids: tuple[int, ...],
    ) -> SiteMeasurementItem | None:
        """Resolve an exact catalog position without treating it as a duplicate.

        The base order is significant: the batch's persisted base wins over a
        newer active copy.  Ambiguous positions within the same base are not
        guessed; callers then retain the regular duplicate validation.
        """
        position_key = _measurement_position_key(position)
        if not position_key:
            return None

        filters = [
            SiteMeasurementItem.site_id == site_id,
            SiteMeasurementItem.measurement_base_id.is_not(None),
            SiteMeasurementItem.measurement_batch_id.is_(None),
            SiteMeasurementItem.is_free_position.is_(False),
            SiteMeasurementItem.is_hidden.is_(False),
        ]
        if measurement_base_ids:
            filters.append(SiteMeasurementItem.measurement_base_id.in_(measurement_base_ids))
        candidates = list(
            self.db.scalars(
                select(SiteMeasurementItem)
                .where(*filters)
                .order_by(SiteMeasurementItem.sort_order, SiteMeasurementItem.id)
            ).all()
        )

        base_ids = measurement_base_ids or tuple(
            dict.fromkeys(
                item.measurement_base_id
                for item in candidates
                if item.measurement_base_id is not None
            )
        )
        for base_id in base_ids:
            matches = [
                item
                for item in candidates
                if item.measurement_base_id == base_id
                and _measurement_position_key(item.position) == position_key
            ]
            if len(matches) == 1:
                return matches[0]
            if len(matches) > 1:
                return None
        return None

    def _next_site_batch_column_sort_order(self, batch: SiteMeasurementBatch) -> int:
        """Append a new office position after this batch's persisted columns.

        Offer positions share their ``sort_order`` with the measurement base, while
        manual positions are owned by a concrete batch.  Limiting the maximum to
        the same item scope as the review table prevents positions from unrelated
        batches (or hidden legacy items) from influencing the column order.
        """
        item_filters = [
            SiteMeasurementItem.site_id == batch.site_id,
            SiteMeasurementItem.is_hidden.is_(False),
        ]
        if (
            batch.position_mode == MeasurementPositionMode.BLANK.value
            or batch.measurement_base_id is None
        ):
            item_filters.extend(
                [
                    SiteMeasurementItem.measurement_batch_id == batch.id,
                    SiteMeasurementItem.is_free_position.is_(True),
                ]
            )
        else:
            item_filters.extend(
                [
                    SiteMeasurementItem.measurement_base_id == batch.measurement_base_id,
                    or_(
                        SiteMeasurementItem.is_free_position.is_(False),
                        SiteMeasurementItem.measurement_batch_id.is_(None),
                        SiteMeasurementItem.measurement_batch_id == batch.id,
                    ),
                ]
            )

        current_max = self.db.scalar(
            select(func.max(SiteMeasurementItem.sort_order)).where(*item_filters)
        )
        return 1 if current_max is None else current_max + 1

    def _ensure_site_batch_can_be_edited_in_office(
        self,
        batch: SiteMeasurementBatch,
    ) -> None:
        if batch.status == "draft" and batch.origin != MeasurementBatchOrigin.OFFICE.value:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Entwürfe werden mobil bearbeitet.",
            )
        if batch.deleted_at is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Archivierte Aufmaße können nicht bearbeitet werden.",
            )
        if (
            batch.customer_signed_at is not None
            or batch.status.casefold() in MEASUREMENT_OFFICE_EDIT_LOCKED_BATCH_STATUSES
        ):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Unterschriebene oder abgeschlossene Aufmaße können nicht bearbeitet werden.",
            )

    def _delete_existing_entries_for_cell(
        self,
        *,
        batch_id: int,
        measurement_item_id: int,
        area_or_comment: str,
    ) -> None:
        area_key = _measurement_entry_area_key(area_or_comment)
        existing_entries = list(
            self.db.scalars(
                select(SiteMeasurementEntry).where(
                    SiteMeasurementEntry.measurement_batch_id == batch_id,
                    SiteMeasurementEntry.measurement_item_id == measurement_item_id,
                )
            ).all()
        )
        for entry in existing_entries:
            if _measurement_entry_area_key(entry.area_or_comment) == area_key:
                self.db.delete(entry)
        self.db.flush()

    def _format_user_display_name(self, user: User | None) -> str | None:
        if user is None:
            return None
        if user.person and user.person.display_name:
            return user.person.display_name
        return user.display_name

    def _build_measurement_base(self, base: SiteMeasurementBase) -> MeasurementBaseRead:
        result = MeasurementBaseRead.model_validate(base)
        result.item_count = self.db.scalar(
            select(func.count(SiteMeasurementItem.id)).where(
                SiteMeasurementItem.measurement_base_id == base.id,
                SiteMeasurementItem.is_hidden.is_(False),
            )
        ) or 0
        result.batch_count = self.db.scalar(
            select(func.count(SiteMeasurementBatch.id)).where(
                SiteMeasurementBatch.measurement_base_id == base.id,
                SiteMeasurementBatch.deleted_at.is_(None),
            )
        ) or 0
        return result

    def _build_mobile_batch(
        self,
        batch: SiteMeasurementBatch,
        active_base_id: int | None = None,
        customer_email_status: CustomerEmailStatus | None = None,
        current_user: User | None = None,
        photo_count: int | None = None,
        calculation_lookup: tuple[dict[int, Decimal], dict[str, Decimal]] | None = None,
    ) -> MobileMeasurementBatchRead:
        visible_entries = [
            entry
            for entry in _current_measurement_entries(list(batch.entries))
            if not (entry.measurement_item and entry.measurement_item.is_hidden)
        ]
        position_ids = {entry.measurement_item_id for entry in visible_entries}
        position_ids.update(
            item.id
            for item in batch.free_items
            if item.is_free_position and not item.is_hidden
        )
        reported_minutes = self._sum_reported_minutes(
            visible_entries,
            calculation_lookup=calculation_lookup,
        )
        reported_hours = reported_minutes / Decimal("60") if reported_minutes is not None else None
        workflow_state = self._mobile_batch_workflow_state(
            batch,
            has_measurement_content=bool(visible_entries) or bool(batch.area_rows),
            can_sign_immediately=_can_sign_measurements_immediately(current_user),
        )
        is_current_offer = bool(
            batch.position_mode == MeasurementPositionMode.OFFER_BASED.value
            and (
                batch.measurement_base_id == active_base_id
                if active_base_id is not None
                else bool(
                    batch.measurement_base
                    and batch.measurement_base.status == "active"
                    and batch.measurement_base.released_to_mobile
                )
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
            origin=batch.origin,
            position_mode=batch.position_mode,
            creator_role_at_creation=batch.creator_role_at_creation,
            area_location=batch.area_location,
            measurement_date=batch.measurement_date,
            assigned_employee_id=batch.assigned_employee_id,
            assigned_employee_name=(
                batch.assigned_employee.display_name if batch.assigned_employee else None
            ),
            has_original_worker_submission=(
                batch.origin != MeasurementBatchOrigin.OFFICE.value
                and batch.submitted_at is not None
                and batch.original_submitted_snapshot is not None
            ),
            created_by_user_id=batch.created_by_user_id,
            created_by_name=self._format_user_display_name(batch.created_by),
            submitted_by_user_id=batch.submitted_by_user_id,
            submitted_by_name=self._format_user_display_name(batch.submitted_by),
            submitted_at=batch.submitted_at,
            customer_signed_at=batch.customer_signed_at,
            customer_signature_name=batch.customer_signature_name,
            customer_signature_place=batch.customer_signature_place,
            customer_email_sent_at=customer_email_status[0] if customer_email_status else None,
            customer_email_signature_present=(
                customer_email_status[1]
                if customer_email_status and customer_email_status[1] is not None
                else (batch.customer_signed_at is not None if customer_email_status else None)
            ),
            worker_signed_at=batch.worker_signed_at,
            worker_signature_name=batch.worker_signature_name,
            deleted_at=batch.deleted_at,
            deleted_by_user_id=batch.deleted_by_user_id,
            deleted_by_name=self._format_user_display_name(batch.deleted_by),
            is_locked_for_worker=batch.customer_signed_at is not None,
            created_at=batch.created_at,
            updated_at=batch.updated_at,
            position_count=len(position_ids),
            entry_count=len(visible_entries),
            reported_minutes=reported_minutes,
            reported_hours=reported_hours,
            photo_count=photo_count if photo_count is not None else self._photo_count_for_batch(batch.id),
            available_actions=MobileMeasurementBatchAvailableActionsRead(
                can_customer_sign=workflow_state["can_customer_sign"],
            ),
            block_reasons=MobileMeasurementBatchBlockReasonsRead(
                customer_sign=workflow_state["customer_sign_reason"],
            ),
            area_rows=[
                self._build_area_row(row)
                for row in sorted(batch.area_rows, key=lambda area_row: (area_row.sort_order, area_row.id))
            ],
        )

    def _photo_counts_by_batch_id(self, *, batch_ids: list[int]) -> dict[int, int]:
        if not batch_ids:
            return {}
        return {
            batch_id: count
            for batch_id, count in self.db.execute(
                select(
                    SiteMeasurementBatchPhoto.measurement_batch_id,
                    func.count(SiteMeasurementBatchPhoto.id),
                )
                .where(SiteMeasurementBatchPhoto.measurement_batch_id.in_(batch_ids))
                .group_by(SiteMeasurementBatchPhoto.measurement_batch_id)
            )
        }

    def _photo_count_for_batch(self, batch_id: int) -> int:
        return self.db.scalar(
            select(func.count(SiteMeasurementBatchPhoto.id)).where(
                SiteMeasurementBatchPhoto.measurement_batch_id == batch_id
            )
        ) or 0

    def _latest_customer_email_statuses(
        self,
        *,
        entity_type: str,
        action: str,
        entity_ids: list[int],
    ) -> dict[int, CustomerEmailStatus]:
        if not entity_ids:
            return {}
        logs = list(
            self.db.scalars(
                select(AuditLog)
                .where(
                    AuditLog.action == action,
                    AuditLog.entity_type == entity_type,
                    AuditLog.entity_id.in_(entity_ids),
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
            caption=photo.caption,
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

    def _mobile_batch_workflow_state(
        self,
        batch: SiteMeasurementBatch,
        *,
        has_measurement_content: bool,
        can_sign_immediately: bool = False,
    ) -> dict[str, object]:
        if batch.customer_signed_at is not None or batch.customer_signature_name:
            return {"can_customer_sign": True, "customer_sign_reason": None}
        if not has_measurement_content:
            return {
                "can_customer_sign": False,
                "customer_sign_reason": "Für die Kundenunterschrift muss mindestens eine Aufmaßzeile erfasst sein.",
            }
        if batch.status in {"approved", "billed", "checked", "closed"}:
            return {
                "can_customer_sign": False,
                "customer_sign_reason": "Dieses Aufmaß ist bereits intern erledigt.",
            }
        if can_sign_immediately and batch.status in {"draft", "submitted", "reviewed", "rejected"}:
            return {"can_customer_sign": True, "customer_sign_reason": None}
        if batch.status == "reviewed":
            return {"can_customer_sign": True, "customer_sign_reason": None}
        return {
            "can_customer_sign": False,
            "customer_sign_reason": "Kundenunterschrift ist erst nach Projektleiterprüfung möglich.",
        }

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

    @staticmethod
    def _batch_has_measurement_content(batch: SiteMeasurementBatch) -> bool:
        return bool(_current_measurement_entries(list(batch.entries))) or bool(batch.area_rows)

    def _next_free_measurement_position(
        self, batch: SiteMeasurementBatch, *, exclude_item_id: int | None = None
    ) -> str:
        statement = select(SiteMeasurementItem.position).where(
            SiteMeasurementItem.site_id == batch.site_id,
        )
        if batch.position_mode == MeasurementPositionMode.BLANK.value:
            statement = statement.where(SiteMeasurementItem.measurement_batch_id == batch.id)
        else:
            statement = statement.where(
                SiteMeasurementItem.measurement_base_id == batch.measurement_base_id
            )
        if exclude_item_id is not None:
            statement = statement.where(SiteMeasurementItem.id != exclude_item_id)
        existing_positions = set(self.db.scalars(statement).all())
        index = 1
        while True:
            candidate = f"FREI-{index}"
            if candidate not in existing_positions:
                return candidate
            index += 1

    def _build_measurement_snapshot(
        self,
        *,
        batch: SiteMeasurementBatch,
        version_label: str,
        event_at: datetime,
    ) -> dict[str, object]:
        entries: list[dict[str, object]] = []
        for entry in _current_measurement_entries(list(batch.entries)):
            item = entry.measurement_item
            if item is None:
                continue
            entries.append(
                {
                    "entry_id": entry.id,
                    "measurement_item_id": item.id,
                    "site_id": entry.site_id,
                    "position": "" if item.is_free_position and _is_technical_free_measurement_position(item.position) else item.position,
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
        current_entries = _current_measurement_entries(list(batch.entries))
        position_ids = {entry.measurement_item_id for entry in current_entries}
        is_customer_signed = batch.customer_signed_at is not None and batch.status not in {
            "billed",
            "approved",
            "closed",
        }
        message_type = "measurement_customer_signed" if is_customer_signed else "measurement_submitted"
        return MeasurementDashboardSubmissionRead(
            message_key=f"{message_type}:{batch.id}",
            batch_id=batch.id,
            site_id=batch.site_id,
            site_name=batch.site.name if batch.site else "Baustelle",
            site_number=batch.site.site_number if batch.site else None,
            title=batch.title,
            status=batch.status,
            message_type=message_type,
            event_at=batch.customer_signed_at if is_customer_signed else batch.submitted_at,
            submitted_by_name=self._format_user_display_name(batch.submitted_by),
            submitted_at=batch.submitted_at,
            customer_signature_name=batch.customer_signature_name,
            customer_signed_at=batch.customer_signed_at,
            entry_count=len(current_entries),
            position_count=len(position_ids),
        )

    def _build_extra_work_dashboard_submission(
        self, ticket: ExtraWorkTicket
    ) -> MeasurementDashboardSubmissionRead:
        return MeasurementDashboardSubmissionRead(
            message_key=f"extra_work_submitted:{ticket.id}",
            batch_id=None,
            extra_work_ticket_id=ticket.id,
            site_id=ticket.site_id,
            site_name=ticket.site.name if ticket.site else "Baustelle",
            site_number=ticket.site.site_number if ticket.site else None,
            title=f"Stundenzettel {ticket.display_number}",
            status=ticket.status,
            message_type="extra_work_submitted",
            event_at=ticket.submitted_at,
            submitted_by_name=self._format_user_display_name(ticket.submitted_by),
            submitted_at=ticket.submitted_at,
            entry_count=len(ticket.entries),
            position_count=0,
        )

    def _build_mobile_item(
        self, item: SiteMeasurementItem, batch_id: int
    ) -> MobileMeasurementItemRead:
        entries = sorted(
            _current_measurement_entries([
                entry for entry in item.entries if entry.measurement_batch_id == batch_id
            ]),
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
            linked_measurement_item_id=item.linked_measurement_item_id,
            source_file_name=item.source_file_name,
            source_project_number=item.source_project_number,
            source_invoice_number=item.source_invoice_number,
            source_customer_name=item.source_customer_name,
            source_section_key=item.source_section_key,
            source_section_title=item.source_section_title,
            position=item.position,
            description=item.description,
            list_quantity=item.list_quantity,
            unit=item.unit,
            minutes_per_unit=item.minutes_per_unit,
            list_minutes_total=item.list_minutes_total,
            is_nep=item.is_nep,
            is_free_position=item.is_free_position,
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
        self,
        entries: list[SiteMeasurementEntry],
        calculation_lookup: tuple[dict[int, Decimal], dict[str, Decimal]] | None = None,
    ) -> Decimal | None:
        total, _missing_item_ids = self._sum_reported_minutes_with_missing(
            entries,
            calculation_lookup=calculation_lookup,
        )
        return total

    def _sum_reported_minutes_with_missing(
        self,
        entries: list[SiteMeasurementEntry],
        calculation_lookup: tuple[dict[int, Decimal], dict[str, Decimal]] | None = None,
    ) -> tuple[Decimal | None, set[int]]:
        total = Decimal("0")
        has_minutes = False
        missing_item_ids: set[int] = set()
        if calculation_lookup is None:
            site_id = next((entry.site_id for entry in entries), None)
            calculation_lookup = self._measurement_calculation_lookup(site_id)
        minutes_by_item_id, minutes_by_unique_position = calculation_lookup
        for entry in entries:
            item = entry.measurement_item
            minutes_per_unit = item.minutes_per_unit
            if minutes_per_unit is None and item.linked_measurement_item_id is not None:
                minutes_per_unit = minutes_by_item_id.get(item.linked_measurement_item_id)
            if minutes_per_unit is None:
                minutes_per_unit = minutes_by_unique_position.get(
                    _measurement_position_key(item.position)
                )
            if minutes_per_unit is None:
                missing_item_ids.add(item.id)
                continue
            total += entry.quantity * minutes_per_unit
            has_minutes = True
        return (total if has_minutes else None), missing_item_ids

    def _measurement_calculation_lookup(
        self,
        site_id: int | None,
    ) -> tuple[dict[int, Decimal], dict[str, Decimal]]:
        if site_id is None:
            return {}, {}
        items = list(
            self.db.scalars(
                select(SiteMeasurementItem).where(
                    SiteMeasurementItem.site_id == site_id,
                    SiteMeasurementItem.measurement_base_id.is_not(None),
                    SiteMeasurementItem.measurement_batch_id.is_(None),
                    SiteMeasurementItem.minutes_per_unit.is_not(None),
                    SiteMeasurementItem.is_hidden.is_(False),
                )
            ).all()
        )
        minutes_by_item_id = {
            item.id: item.minutes_per_unit
            for item in items
            if item.id is not None and item.minutes_per_unit is not None
        }
        item_ids_by_position: dict[str, list[int]] = {}
        for item in items:
            position_key = _measurement_position_key(item.position)
            if position_key and item.id is not None:
                item_ids_by_position.setdefault(position_key, []).append(item.id)
        minutes_by_unique_position = {
            position_key: minutes_by_item_id[item_ids[0]]
            for position_key, item_ids in item_ids_by_position.items()
            if len(item_ids) == 1
        }
        return minutes_by_item_id, minutes_by_unique_position

    @staticmethod
    def _analysis_timestamp(batch: SiteMeasurementBatch) -> datetime | None:
        return batch.submitted_at or batch.customer_signed_at or batch.updated_at or batch.created_at

    @staticmethod
    def _extra_work_ticket_timestamp(ticket: ExtraWorkTicket) -> datetime | None:
        return ticket.submitted_at or ticket.customer_signed_at or ticket.updated_at or ticket.created_at

    @staticmethod
    def _local_analysis_datetime(value: datetime) -> datetime:
        if value.tzinfo is None:
            return value
        return value.astimezone(MEASUREMENT_ARCHIVE_TIMEZONE).replace(tzinfo=None)

    @staticmethod
    def _entry_work_minutes(
        entry: WorkTimeEntry,
        project_mounting_contexts: dict[int, dict[str, object]] | None = None,
    ) -> Decimal:
        if entry.id is not None and project_mounting_contexts:
            context = project_mounting_contexts.get(entry.id)
            if context is not None and context.get("work_minutes") is not None:
                return Decimal(str(context["work_minutes"] or 0))
        minutes = TimeEntryService.project_mounting_work_minutes(entry)
        return Decimal(str(minutes or 0))

    def _sum_work_minutes_for_period(
        self,
        entries: list[WorkTimeEntry],
        *,
        period_start: datetime | None,
        period_end: datetime | None,
        project_mounting_contexts: dict[int, dict[str, object]] | None = None,
    ) -> Decimal:
        total = Decimal("0")
        for entry in entries:
            entry_minutes = self._entry_work_minutes(
                entry,
                project_mounting_contexts=project_mounting_contexts,
            )
            if entry_minutes <= 0:
                continue
            ratio = self._work_entry_overlap_ratio(entry, period_start=period_start, period_end=period_end)
            if ratio <= 0:
                continue
            total += entry_minutes * ratio
        return total

    @staticmethod
    def _work_entry_overlap_ratio(
        entry: WorkTimeEntry,
        *,
        period_start: datetime | None,
        period_end: datetime | None,
    ) -> Decimal:
        if period_end is None:
            return Decimal("0")

        if entry.start_time is not None and entry.end_time is not None:
            entry_start = datetime.combine(entry.work_date, entry.start_time)
            entry_end = datetime.combine(entry.work_date, entry.end_time)
            if entry_end <= entry_start:
                entry_end += timedelta(days=1)
            overlap_start = max(entry_start, period_start) if period_start is not None else entry_start
            overlap_end = min(entry_end, period_end)
            if overlap_end <= overlap_start:
                return Decimal("0")
            interval_seconds = Decimal(str((entry_end - entry_start).total_seconds()))
            overlap_seconds = Decimal(str((overlap_end - overlap_start).total_seconds()))
            return overlap_seconds / interval_seconds if interval_seconds > 0 else Decimal("0")

        entry_day = datetime.combine(entry.work_date, time(12, 0))
        if period_start is not None and entry_day <= period_start:
            return Decimal("0")
        if entry_day > period_end:
            return Decimal("0")
        return Decimal("1")

    def _find_analysis_row_index(
        self,
        row_payloads: list[dict[str, object]],
        relevant_at: datetime | None,
    ) -> int:
        if not row_payloads:
            return 0
        if relevant_at is None:
            return len(row_payloads) - 1

        relevant_boundary = self._local_analysis_datetime(relevant_at)
        selected_index = 0
        for index, payload in enumerate(row_payloads):
            boundary = payload["boundary"]
            if boundary is None:
                selected_index = index
                continue
            if boundary <= relevant_boundary:
                selected_index = index
                continue
            break
        return selected_index

    @staticmethod
    def _extra_work_ticket_planned_minutes(ticket: ExtraWorkTicket) -> Decimal:
        total_hours = ticket.total_hours or Decimal("0")
        if total_hours <= 0 and ticket.estimated_hours is not None:
            total_hours = ticket.estimated_hours
        return total_hours * Decimal("60")

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

    @staticmethod
    def _measurement_area_key(value: str) -> str:
        return " ".join(value.split()).casefold()

    def _build_area_row(self, row: SiteMeasurementAreaRow) -> MeasurementAreaRowRead:
        return MeasurementAreaRowRead(
            id=row.id,
            measurement_batch_id=row.measurement_batch_id,
            site_id=row.site_id,
            area_or_comment=row.area_or_comment,
            sort_order=row.sort_order,
            created_by_user_id=row.created_by_user_id,
            created_by_name=self._format_user_display_name(row.created_by),
            created_at=row.created_at,
            updated_at=row.updated_at,
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


def _can_sign_measurements_immediately(user: User | None) -> bool:
    return bool(user and user.person and user.person.can_sign_measurements_immediately)


def format_site_signature_location(site: Site | None) -> str:
    if site is None:
        return "Baustelle"
    street_line = " ".join(
        part.strip()
        for part in [site.street, site.house_number]
        if isinstance(part, str) and part.strip()
    )
    city_line = " ".join(
        part.strip()
        for part in [site.postal_code, site.city]
        if isinstance(part, str) and part.strip()
    )
    structured = ", ".join(part for part in [street_line, city_line] if part)
    if structured:
        return _trim_signature_location(structured)
    for value in (site.address, site.location):
        if isinstance(value, str) and value.strip():
            return _trim_signature_location(" ".join(value.split()))
    return "Baustelle"


def _trim_signature_location(value: str) -> str:
    return value[:260].rstrip() or "Baustelle"


def _normalize_content_type(value: str | None) -> str:
    return (value or "application/octet-stream").split(";", 1)[0].strip().lower()


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
