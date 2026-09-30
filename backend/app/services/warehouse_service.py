import hashlib
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import exists, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import Person, ToolIssueReport, ToolMaterialItem, User
from app.models.enums import PersonEmploymentStatus, ToolMaterialStatus
from app.models.warehouse_movement import WarehouseMovement
from app.schemas.warehouse import Direction, WarehouseMovementCreate, WarehouseToolRead


def active_person():
    return (Person.is_active.is_(True), Person.deleted_at.is_(None),
            Person.employment_status == PersonEmploymentStatus.ACTIVE.value)


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
            statement = statement.where(*active_person())
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
        fingerprint = hashlib.sha256(f"{actor.id}:{payload.model_dump_json()}".encode()).hexdigest()
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
            movement.items = [WarehouseToolRead.model_validate(item).model_dump() for item in items]
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
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise
        self.db.refresh(movement)
        return movement

    def _existing(self, request_id: str, fingerprint: str):
        existing = self.db.scalar(select(WarehouseMovement).where(WarehouseMovement.request_id == request_id))
        if existing and existing.request_hash != fingerprint:
            raise HTTPException(409, "Diese Vorgangskennung wurde bereits für eine andere Buchung verwendet.")
        return existing

    def _person(self, employee_id: int, direction: Direction):
        statement = select(Person).where(Person.id == employee_id)
        if direction == "issue":
            statement = statement.where(*active_person())
        person = self.db.scalar(statement)
        if person is None:
            raise HTTPException(409, "Der Mitarbeiter ist nicht mehr verfügbar. Bitte erneut auswählen.")
        return person
