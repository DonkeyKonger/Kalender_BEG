from datetime import date, datetime, timezone
from decimal import Decimal

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.models.assignment import Assignment
from app.models.site import Site
from app.models.site_measurement_item import (
    SiteMeasurementBase,
    SiteMeasurementBatch,
    SiteMeasurementEntry,
    SiteMeasurementItem,
)
from app.models.user import User
from app.schemas.measurement import (
    MeasurementBaseRead,
    MeasurementBaseUpdate,
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
                .join(SiteMeasurementBatch.measurement_base)
                .where(
                    SiteMeasurementBatch.site_id == assignment.site_id,
                    SiteMeasurementBase.status == "active",
                    SiteMeasurementBase.released_to_mobile.is_(True),
                )
                .order_by(SiteMeasurementBatch.number, SiteMeasurementBatch.id)
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

    def set_site_batch_billing_status(
        self, *, site_id: int, batch_id: int, billing_status: str
    ) -> MobileMeasurementBatchRead:
        normalized_status = {
            "open": "submitted",
            "noch_offen": "submitted",
            "rejected": "submitted",
            "approved": "billed",
            "abgerechnet": "billed",
        }.get(billing_status, billing_status)
        if normalized_status not in {"submitted", "billed"}:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Ungültiger Abrechnungsstatus.")

        self._get_site(site_id)
        batch = self._get_batch_for_site(batch_id, site_id)
        if batch.status == "draft":
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Entwürfe können noch nicht abgerechnet werden.",
            )

        batch.status = normalized_status
        for entry in batch.entries:
            entry.status = normalized_status
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
                .where(SiteMeasurementBatch.status.in_(("submitted", "rejected")))
                .order_by(
                    SiteMeasurementBatch.submitted_at.desc(),
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
            created_at=batch.created_at,
            updated_at=batch.updated_at,
            position_count=len(position_ids),
            entry_count=len(batch.entries),
            reported_minutes=reported_minutes,
            reported_hours=reported_hours,
        )

    def _build_original_submitted_snapshot(
        self,
        *,
        batch: SiteMeasurementBatch,
        submitted_by: User,
        submitted_at: datetime,
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
            "submitted_by_user_id": submitted_by.id,
            "submitted_by_name": self._format_user_display_name(submitted_by),
            "submitted_at": submitted_at.isoformat(),
            "entries": entries,
        }

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
            submitted_by_name=self._format_user_display_name(batch.submitted_by),
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
