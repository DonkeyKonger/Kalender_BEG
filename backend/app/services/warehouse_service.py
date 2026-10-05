import hashlib
import json
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import exists, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import Person, Site, ToolIssueReport, ToolMaterialItem, User
from app.models.enums import (
    PersonEmploymentStatus,
    PersonType,
    ToolIssueReason,
    ToolIssueStatus,
    ToolMaterialStatus,
    UserRole,
)
from app.models.warehouse_movement import WarehouseMovement
from app.schemas.warehouse import Direction, WarehouseMovementCreate, WarehouseToolRead
from app.services.tool_issue_report_service import NO_RESPONSIBLE_USER_MESSAGE
from app.services.tool_material_responsibility_service import get_tool_responsible_user


def eligible_issue_person():
    # A personal login is optional. Office/manager accounts (even disabled ones)
    # and legacy site-manager assignments must not turn into warehouse recipients.
    non_worker = Person.users.any(User.role.in_([UserRole.ADMIN, UserRole.OFFICE, UserRole.PROJECT_MANAGER]))
    site_manager = exists().where(Site.project_manager_person_id == Person.id)
    return (Person.is_active.is_(True), Person.deleted_at.is_(None),
            Person.employment_status == PersonEmploymentStatus.ACTIVE.value,
            Person.person_type == PersonType.INTERNAL, ~non_worker, ~site_manager)


def eligible_tools(direction: Direction, employee_id: int):
    if direction == "return":
        return (ToolMaterialItem.status == ToolMaterialStatus.ISSUED, ToolMaterialItem.employee_id == employee_id)
    # A returned tool with an unresolved defect/loss report must not be issued again.
    unresolved = exists().where(ToolIssueReport.tool_id == ToolMaterialItem.id, ToolIssueReport.resolved_at.is_(None))
    return (ToolMaterialItem.status == ToolMaterialStatus.WAREHOUSE, ToolMaterialItem.employee_id.is_(None), ~unresolved)


class WarehouseService:
    def __init__(self, db: Session):
        self.db = db

    def people(self, direction: Direction):
        statement = select(Person)
        if direction == "issue":
            statement = statement.where(*eligible_issue_person())
        else:
            # Outstanding equipment can also be returned for departed/inactive employees.
            statement = statement.where(exists().where(
                ToolMaterialItem.employee_id == Person.id, ToolMaterialItem.status == ToolMaterialStatus.ISSUED,
            ))
        return self.db.scalars(statement.order_by(func.lower(Person.display_name), Person.id)).all()

    def tools(self, direction: Direction, employee_id: int, search: str, offset: int, limit: int):
        self._person(employee_id, direction)
        statement = select(ToolMaterialItem).where(*eligible_tools(direction, employee_id))
        if search.strip():
            needle = search.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            statement = statement.where(or_(*(
                column.ilike(f"%{needle}%", escape="\\") for column in (
                    ToolMaterialItem.beg_number, ToolMaterialItem.designation, ToolMaterialItem.manufacturer,
                    ToolMaterialItem.device_number, ToolMaterialItem.serial_number,
                )
            )))
        total = self.db.scalar(select(func.count()).select_from(statement.subquery())) or 0
        items = self.db.scalars(statement.order_by(
            ToolMaterialItem.beg_number, ToolMaterialItem.designation, ToolMaterialItem.id,
        ).offset(offset).limit(limit)).all()
        return items, total

    def book(self, payload: WarehouseMovementCreate, actor: User) -> WarehouseMovement:
        request_id = str(payload.request_id)
        fingerprint_payload = self._fingerprint_payload(payload)
        fingerprint = hashlib.sha256(f"{actor.id}:{fingerprint_payload}".encode()).hexdigest()
        existing = self._existing(request_id, fingerprint)
        if existing:
            return existing
        person = self._person(payload.employee_id, payload.direction)
        movement = WarehouseMovement(
            request_id=request_id, request_hash=fingerprint, direction=payload.direction,
            employee_id_snapshot=person.id, employee_name=person.display_name,
            actor_user_id=actor.id, actor_name=actor.display_name, items=[],
            signature_strokes=[[point.model_dump() for point in stroke] for stroke in payload.signature_strokes],
            created_at=datetime.now(timezone.utc),
        )
        self.db.add(movement)
        try:
            # Reserve the idempotency key before changing any stock. Concurrent retries wait here.
            self.db.flush()
        except IntegrityError:
            self.db.rollback()
            existing = self._existing(request_id, fingerprint)
            if existing:
                return existing
            raise
        try:
            items = self.db.scalars(select(ToolMaterialItem).where(
                ToolMaterialItem.id.in_(payload.tool_ids),
            ).order_by(ToolMaterialItem.id).with_for_update()).all()
            if len(items) != len(payload.tool_ids):
                raise HTTPException(409, "Ein Werkzeug wurde entfernt. Bitte die Auswahl erneut prüfen.")
            report_recipient = None
            if any(reason != "warehouse" for reason in payload.return_reasons.values()):
                report_recipient = get_tool_responsible_user(self.db)
                if report_recipient is None:
                    raise HTTPException(409, NO_RESPONSIBLE_USER_MESSAGE)
            movement.items = []
            for item in items:
                snapshot = WarehouseToolRead.model_validate(item).model_dump()
                if payload.direction == "return":
                    snapshot["return_reason"] = payload.return_reasons.get(item.id, "warehouse")
                movement.items.append(snapshot)
            for item in items:
                result = self.db.execute(update(ToolMaterialItem).where(
                    ToolMaterialItem.id == item.id, *eligible_tools(payload.direction, person.id),
                ).values(
                    status=ToolMaterialStatus.ISSUED if payload.direction == "issue" else ToolMaterialStatus.WAREHOUSE,
                    employee_id=person.id if payload.direction == "issue" else None,
                    item_date=datetime.now(ZoneInfo("Europe/Berlin")).date(),
                ).execution_options(synchronize_session=False))
                if result.rowcount != 1:
                    raise HTTPException(409, f"BEG-Nr. {item.beg_number or '–'} ist nicht mehr verfügbar. "
                                        "Es wurde nichts gebucht. Bitte die Auswahl erneut prüfen.")
                return_reason = payload.return_reasons.get(item.id)
                if return_reason in {"defective", "lost"}:
                    self.db.add(ToolIssueReport(
                        tool_id=item.id,
                        tool_id_snapshot=item.id,
                        tool_beg_number_snapshot=item.beg_number,
                        tool_manufacturer_snapshot=item.manufacturer,
                        tool_designation_snapshot=item.designation,
                        reason=(ToolIssueReason.DEFECTIVE if return_reason == "defective"
                                else ToolIssueReason.LOST),
                        status=ToolIssueStatus.OPEN,
                        reporter_user_id=actor.id,
                        reporter_employee_id=person.id,
                        reporter_last_name_snapshot=person.last_name,
                        recipient_user_id=report_recipient.id,
                        request_id=f"{request_id}:{item.id}",
                    ))
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise
        self.db.refresh(movement)
        return movement

    @staticmethod
    def _fingerprint_payload(payload: WarehouseMovementCreate) -> str:
        # Keep the exact legacy JSON for old clients and normalize an explicitly
        # selected default so both requests replay the same immutable receipt.
        serialized = payload.model_dump_json(exclude={"return_reasons"})
        if not payload.return_reasons or all(
            reason == "warehouse" for reason in payload.return_reasons.values()
        ):
            return serialized
        reasons = json.dumps(
            dict(sorted(payload.return_reasons.items())), separators=(",", ":"),
        )
        return f'{serialized[:-1]},"return_reasons":{reasons}}}'

    def _existing(self, request_id: str, fingerprint: str):
        existing = self.db.scalar(select(WarehouseMovement).where(WarehouseMovement.request_id == request_id))
        if existing and existing.request_hash != fingerprint:
            raise HTTPException(409, "Diese Vorgangskennung wurde bereits für eine andere Buchung verwendet.")
        return existing

    def _person(self, employee_id: int, direction: Direction):
        statement = select(Person).where(Person.id == employee_id)
        if direction == "issue":
            statement = statement.where(*eligible_issue_person())
        person = self.db.scalar(statement)
        if person is None:
            raise HTTPException(409, "Der Mitarbeiter ist nicht mehr verfügbar. Bitte erneut auswählen.")
        return person
