from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, JSON, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class WarehouseMovement(Base):
    """Immutable handover receipt; snapshots survive inventory/person changes."""

    __tablename__ = "warehouse_movements"
    __table_args__ = (
        CheckConstraint("direction IN ('issue', 'return')", name="ck_warehouse_movement_direction"),
        Index("ix_warehouse_movements_created_id", "created_at", "id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    request_id: Mapped[str] = mapped_column(String(36), unique=True, nullable=False)
    request_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    direction: Mapped[str] = mapped_column(String(10), nullable=False)
    employee_id_snapshot: Mapped[int] = mapped_column(nullable=False, index=True)
    employee_name: Mapped[str] = mapped_column(String(200), nullable=False)
    actor_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    actor_name: Mapped[str] = mapped_column(String(200), nullable=False)
    items: Mapped[list[dict]] = mapped_column(JSON, nullable=False)
    signature_strokes: Mapped[list[list[dict]]] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
