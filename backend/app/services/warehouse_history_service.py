from datetime import datetime, time, timezone
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import String, cast, exists, func, or_, select
from sqlalchemy.orm import Session, defer

from app.models.warehouse_movement import WarehouseMovement
from app.models.enums import UserRole
from app.schemas.warehouse import WarehouseHistoryQuery, WarehouseReviewUpdate
from app.services.audit_service import AuditService
from app.services.tool_material_responsibility_service import get_tool_responsible_user


class WarehouseHistoryService:
    """Snapshot-based log; reviewing never changes inventory or signed contents."""

    def __init__(self, db: Session):
        self.db = db

    def list_page(self, query: WarehouseHistoryQuery):
        statement = select(WarehouseMovement)
        if query.direction:
            statement = statement.where(WarehouseMovement.direction == query.direction)
        if query.review_status:
            statement = statement.where(WarehouseMovement.reviewed_at.is_not(None) if query.review_status == "reviewed"
                                        else WarehouseMovement.reviewed_at.is_(None))
        berlin = ZoneInfo("Europe/Berlin")
        if query.date_from:
            start = datetime.combine(query.date_from, time.min, tzinfo=berlin).astimezone(timezone.utc)
            statement = statement.where(WarehouseMovement.created_at >= start)
        if query.date_to:
            end = datetime.combine(query.date_to, time.max, tzinfo=berlin).astimezone(timezone.utc)
            statement = statement.where(WarehouseMovement.created_at <= end)
        search = query.search.strip()
        if search:
            escaped = search.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            pattern = f"%{escaped}%"
            statement = statement.where(or_(
                WarehouseMovement.employee_name.ilike(pattern, escape="\\"),
                WarehouseMovement.actor_name.ilike(pattern, escape="\\"),
                cast(WarehouseMovement.id, String) == search.removeprefix("#"),
                self._tool_search(pattern),
            ))
        total = self.db.scalar(select(func.count()).select_from(statement.subquery())) or 0
        rows = self.db.scalars(statement.options(
            defer(WarehouseMovement.signature_strokes), defer(WarehouseMovement.request_hash),
        ).order_by(WarehouseMovement.created_at.desc(), WarehouseMovement.id.desc())
            .offset((query.page - 1) * query.page_size).limit(query.page_size)).all()
        return rows, total

    def get_receipt(self, movement_id: int):
        receipt = self.db.get(WarehouseMovement, movement_id)
        if receipt is None:
            raise HTTPException(404, "Lagerbeleg nicht gefunden.")
        return receipt

    def can_review(self, user) -> bool:
        if not user.is_active:
            return False
        if user.role == UserRole.ADMIN:
            return True
        responsible = get_tool_responsible_user(self.db)
        return responsible is not None and responsible.id == getattr(user, "id", None)

    def review(self, movement_id: int, payload: WarehouseReviewUpdate, user):
        if not self.can_review(user):
            raise HTTPException(403, "Nur der Werkzeug-Beauftragte oder ein Admin darf Lagerbuchungen prüfen.")
        receipt = self.db.scalar(select(WarehouseMovement).where(WarehouseMovement.id == movement_id)
                                 .with_for_update().execution_options(populate_existing=True))
        if receipt is None:
            raise HTTPException(404, "Lagerbeleg nicht gefunden.")
        # Repeating an already applied target state is safe after a lost response.
        if (receipt.reviewed_at is not None) == payload.reviewed:
            return receipt
        if receipt.review_version != payload.expected_version:
            raise HTTPException(409, "Der Prüfstatus wurde zwischenzeitlich geändert. Bitte aktualisieren.")
        old = self._review_snapshot(receipt)
        receipt.reviewed_at = datetime.now(timezone.utc) if payload.reviewed else None
        receipt.reviewed_by_user_id = user.id if payload.reviewed else None
        receipt.reviewed_by_name = user.display_name if payload.reviewed else None
        receipt.review_version += 1
        AuditService(self.db).record(user_id=user.id, action="warehouse_movement.reviewed" if payload.reviewed else "warehouse_movement.review_reset",
            entity_type="warehouse_movement", entity_id=receipt.id, old_value=old, new_value=self._review_snapshot(receipt))
        self.db.commit()
        self.db.refresh(receipt)
        return receipt

    @staticmethod
    def _review_snapshot(receipt):
        return {"status": receipt.review_status, "reviewed_at": receipt.reviewed_at.isoformat() if receipt.reviewed_at else None,
                "reviewed_by_user_id": receipt.reviewed_by_user_id, "reviewed_by_name": receipt.reviewed_by_name,
                "version": receipt.review_version}

    def _tool_search(self, pattern: str):
        # Extract JSON values rather than matching serialized JSON keys or escaped umlauts.
        postgres = self.db.get_bind().dialect.name == "postgresql"
        elements = (func.json_array_elements(WarehouseMovement.items) if postgres
                    else func.json_each(WarehouseMovement.items)).table_valued("value").alias("receipt_tool")
        fields = ("beg_number", "designation", "manufacturer", "item_type", "device_number", "serial_number")
        values = [elements.c.value.op("->>")(field) if postgres
                  else func.json_extract(elements.c.value, f"$.{field}") for field in fields]
        return exists(select(1).select_from(elements).where(or_(*(
            value.ilike(pattern, escape="\\") for value in values
        ))).correlate(WarehouseMovement))
