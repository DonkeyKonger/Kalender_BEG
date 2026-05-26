from datetime import datetime, timezone
from decimal import Decimal

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.models.assignment import Assignment
from app.models.site import Site
from app.models.site_measurement_item import (
    SiteMeasurementBatch,
    SiteMeasurementEntry,
    SiteMeasurementItem,
)
from app.models.user import User
from app.schemas.measurement import (
    MeasurementEntryCreate,
    MeasurementDashboardSubmissionRead,
    MeasurementEntryRead,
    MobileMeasurementBatchRead,
    MobileMeasurementItemRead,
)
from app.services.measurement_timesheet_parser import (
    MeasurementTimesheetParseError,
    parse_measurement_timesheet_pdf,
)


class MeasurementService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def list_items(self, site_id: int) -> list[SiteMeasurementItem]:
        self._get_site(site_id)
        return list(
            self.db.scalars(
                select(SiteMeasurementItem)
                .where(SiteMeasurementItem.site_id == site_id)
                .order_by(SiteMeasurementItem.sort_order, SiteMeasurementItem.id)
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
                    selectinload(SiteMeasurementBatch.submitted_by),
                )
                .where(SiteMeasurementBatch.site_id == assignment.site_id)
                .order_by(SiteMeasurementBatch.number, SiteMeasurementBatch.id)
            ).all()
        )
        return [self._build_mobile_batch(batch) for batch in batches]

    def create_mobile_batch(
        self, *, assignment_id: int, current_user: User
    ) -> MobileMeasurementBatchRead:
        assignment = self._get_user_assignment(assignment_id, current_user)
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
            number=next_number,
            title=f"Aufmaß {next_number}",
            status="draft",
            created_by_user_id=current_user.id,
        )
        self.db.add(batch)
        self.db.commit()
        self.db.refresh(batch)
        return self._build_mobile_batch(batch)

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
                .where(SiteMeasurementItem.site_id == batch.site_id)
                .order_by(SiteMeasurementItem.sort_order, SiteMeasurementItem.id)
            ).all()
        )
        return [self._build_mobile_item(item, batch.id) for item in items]

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

        item = self.db.get(SiteMeasurementItem, measurement_item_id)
        if item is None or item.site_id != assignment.site_id:
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

    def submit_mobile_batch(
        self, *, assignment_id: int, batch_id: int, current_user: User
    ) -> MobileMeasurementBatchRead:
        assignment = self._get_user_assignment(assignment_id, current_user)
        batch = self._get_batch_for_site(batch_id, assignment.site_id)
        if batch.status != "draft":
            raise HTTPException(status.HTTP_409_CONFLICT, "Dieses Aufmaß ist kein Entwurf mehr.")
        if not batch.entries:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "Ein Aufmaß ohne Aufmaßzeilen kann nicht gesendet werden.",
            )

        batch.status = "submitted"
        batch.submitted_by_user_id = current_user.id
        batch.submitted_at = datetime.now(timezone.utc)
        self.db.commit()
        self.db.refresh(batch)
        return self._build_mobile_batch(batch)

    def list_site_batches(self, site_id: int) -> list[MobileMeasurementBatchRead]:
        self._get_site(site_id)
        batches = list(
            self.db.scalars(
                select(SiteMeasurementBatch)
                .options(
                    selectinload(SiteMeasurementBatch.entries).selectinload(
                        SiteMeasurementEntry.measurement_item
                    ),
                    selectinload(SiteMeasurementBatch.submitted_by),
                )
                .where(SiteMeasurementBatch.site_id == site_id)
                .order_by(SiteMeasurementBatch.number, SiteMeasurementBatch.id)
            ).all()
        )
        return [self._build_mobile_batch(batch) for batch in batches]

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
                .where(SiteMeasurementItem.site_id == batch.site_id)
                .order_by(SiteMeasurementItem.sort_order, SiteMeasurementItem.id)
            ).all()
        )
        return [self._build_mobile_item(item, batch.id) for item in items]

    def review_site_batch(
        self, *, site_id: int, batch_id: int, review_status: str
    ) -> MobileMeasurementBatchRead:
        if review_status not in {"approved", "rejected"}:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Ungültiger Prüfstatus.")

        self._get_site(site_id)
        batch = self._get_batch_for_site(batch_id, site_id)
        if batch.status != "submitted":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Nur eingereichte Aufmaße können geprüft werden.",
            )

        batch.status = review_status
        for entry in batch.entries:
            entry.status = review_status
        self.db.commit()
        self.db.refresh(batch)
        return self._build_mobile_batch(batch)

    def list_dashboard_submissions(
        self, *, limit: int = 6
    ) -> list[MeasurementDashboardSubmissionRead]:
        batches = list(
            self.db.scalars(
                select(SiteMeasurementBatch)
                .options(
                    selectinload(SiteMeasurementBatch.site),
                    selectinload(SiteMeasurementBatch.entries),
                    selectinload(SiteMeasurementBatch.submitted_by),
                )
                .where(SiteMeasurementBatch.status == "submitted")
                .order_by(
                    SiteMeasurementBatch.submitted_at.desc(),
                    SiteMeasurementBatch.updated_at.desc(),
                )
                .limit(limit)
            ).all()
        )
        return [self._build_dashboard_submission(batch) for batch in batches]

    def import_timesheet(
        self, site_id: int, *, file_name: str | None, pdf_content: bytes
    ) -> tuple[dict, list[SiteMeasurementItem]]:
        self._get_site(site_id)
        try:
            parsed = parse_measurement_timesheet_pdf(pdf_content)
        except MeasurementTimesheetParseError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

        if parsed.source_invoice_number and self._invoice_already_imported(
            site_id, parsed.source_invoice_number
        ):
            raise HTTPException(status.HTTP_409_CONFLICT, "Zeitenliste wurde bereits importiert.")

        items = [
            SiteMeasurementItem(
                site_id=site_id,
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
                sort_order=item.sort_order,
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
        }
        return summary, items

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
                selectinload(SiteMeasurementBatch.submitted_by),
            )
            .where(SiteMeasurementBatch.id == batch_id, SiteMeasurementBatch.site_id == site_id)
        )
        if batch is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Aufmaß nicht gefunden.")
        return batch

    def _build_mobile_batch(self, batch: SiteMeasurementBatch) -> MobileMeasurementBatchRead:
        position_ids = {entry.measurement_item_id for entry in batch.entries}
        reported_minutes = self._sum_reported_minutes(batch.entries)
        reported_hours = reported_minutes / Decimal("60") if reported_minutes is not None else None
        return MobileMeasurementBatchRead(
            id=batch.id,
            site_id=batch.site_id,
            number=batch.number,
            title=batch.title,
            status=batch.status,
            created_by_user_id=batch.created_by_user_id,
            submitted_by_user_id=batch.submitted_by_user_id,
            submitted_by_name=batch.submitted_by.display_name if batch.submitted_by else None,
            submitted_at=batch.submitted_at,
            created_at=batch.created_at,
            updated_at=batch.updated_at,
            position_count=len(position_ids),
            entry_count=len(batch.entries),
            reported_minutes=reported_minutes,
            reported_hours=reported_hours,
        )

    def _build_dashboard_submission(
        self, batch: SiteMeasurementBatch
    ) -> MeasurementDashboardSubmissionRead:
        position_ids = {entry.measurement_item_id for entry in batch.entries}
        return MeasurementDashboardSubmissionRead(
            batch_id=batch.id,
            site_id=batch.site_id,
            site_name=batch.site.name if batch.site else "Baustelle",
            site_number=batch.site.site_number if batch.site else None,
            title=batch.title,
            status=batch.status,
            submitted_by_name=batch.submitted_by.display_name if batch.submitted_by else None,
            submitted_at=batch.submitted_at,
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
            mobile_status = "approved" if all(entry.status == "approved" for entry in entries) else "edited"

        return MobileMeasurementItemRead(
            id=item.id,
            site_id=item.site_id,
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

    def _get_site(self, site_id: int) -> Site:
        site = self.db.get(Site, site_id)
        if site is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Baustelle nicht gefunden.")
        return site

    def _invoice_already_imported(self, site_id: int, invoice_number: str) -> bool:
        return (
            self.db.scalar(
                select(SiteMeasurementItem.id)
                .where(
                    SiteMeasurementItem.site_id == site_id,
                    SiteMeasurementItem.source_invoice_number == invoice_number,
                )
                .limit(1)
            )
            is not None
        )
