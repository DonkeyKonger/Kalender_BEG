from datetime import datetime, time, timezone
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import String, cast, exists, func, or_, select
from sqlalchemy.orm import Session, defer

from app.models.warehouse_movement import WarehouseMovement
from app.schemas.warehouse import WarehouseHistoryQuery


class WarehouseHistoryService:
    """Read only, snapshot-based office log. No live inventory joins or edits."""

    def __init__(self, db: Session):
        self.db = db

    def list_page(self, query: WarehouseHistoryQuery):
        statement = select(WarehouseMovement)
        if query.direction:
            statement = statement.where(WarehouseMovement.direction == query.direction)
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
