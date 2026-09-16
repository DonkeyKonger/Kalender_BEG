"""Derived measurement documents; deliberately not part of the quantity ledger."""
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, JSON, String, event, inspect, select, update
from sqlalchemy.orm import Mapped, Session, mapped_column

from app.models.base import Base, TimestampMixin
from app.models.site_measurement_item import (
    SiteMeasurementAreaRow, SiteMeasurementBatch, SiteMeasurementBatchPhoto,
    SiteMeasurementEntry, SiteMeasurementItem,
)


class MeasurementGroup(TimestampMixin, Base):
    __tablename__ = "measurement_groups"

    id: Mapped[int] = mapped_column(primary_key=True)
    site_id: Mapped[int] = mapped_column(ForeignKey("sites.id", ondelete="CASCADE"), index=True)
    number_label: Mapped[str] = mapped_column(String(100))
    created_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    invalidated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    sources: Mapped[list] = mapped_column(JSON)
    snapshot: Mapped[dict] = mapped_column(JSON, deferred=True)
    position_count: Mapped[int] = mapped_column()
    worker_signature_count: Mapped[int] = mapped_column()
    has_customer_signature: Mapped[bool] = mapped_column(Boolean)
    __table_args__ = (Index("uq_measurement_group_active_number", "site_id", "number_label", unique=True,
                           postgresql_where=invalidated_at.is_(None), sqlite_where=invalidated_at.is_(None)),)


class MeasurementGroupMember(Base):
    __tablename__ = "measurement_group_members"

    group_id: Mapped[int] = mapped_column(ForeignKey("measurement_groups.id", ondelete="CASCADE"), primary_key=True)
    batch_id: Mapped[int] = mapped_column(ForeignKey("site_measurement_batches.id", ondelete="CASCADE"), primary_key=True)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    __table_args__ = (Index("uq_measurement_group_active_batch", "batch_id", unique=True,
                           postgresql_where=active.is_(True), sqlite_where=active.is_(True)),)


def invalidate_groups(connection, batch_ids):
    if not batch_ids:
        return
    members = MeasurementGroupMember.__table__
    group_ids = list(connection.scalars(select(members.c.group_id).where(
        members.c.batch_id.in_(batch_ids), members.c.active.is_(True))))
    if group_ids:
        connection.execute(update(MeasurementGroup.__table__).where(MeasurementGroup.id.in_(group_ids)).values(
            invalidated_at=datetime.now(timezone.utc)))
        connection.execute(update(members).where(members.c.group_id.in_(group_ids)).values(active=False))


@event.listens_for(Session, "before_flush")
def invalidate_changed_measurement_groups(session, _context, _instances):
    """Invalidate atomically with the edit, on desktop AND mobile paths.

    Lock the same source rows as creation, so an edit racing with creation cannot
    leave a summary of the pre-edit version visible. Never delete source records.
    """
    batch_ids, item_ids = set(), set()
    for obj in session.new.union(session.dirty).union(session.deleted):
        if obj in session.dirty and not session.is_modified(obj, include_collections=False):
            continue
        if isinstance(obj, SiteMeasurementBatch):
            if obj.id:
                batch_ids.add(obj.id)
        elif isinstance(obj, (SiteMeasurementEntry, SiteMeasurementAreaRow, SiteMeasurementBatchPhoto, SiteMeasurementItem)):
            if obj.measurement_batch_id:
                batch_ids.add(obj.measurement_batch_id)
            # Relationship assignment need not populate the FK until flush.
            parent = inspect(obj).attrs.measurement_batch.loaded_value
            if isinstance(parent, SiteMeasurementBatch) and parent.id:
                batch_ids.add(parent.id)
            history = inspect(obj).attrs.measurement_batch_id.history
            batch_ids.update(value for value in history.deleted if value)
            if isinstance(obj, SiteMeasurementItem) and obj.id:
                item_ids.add(obj.id)
    if item_ids:
        connection = session.connection()
        batch_ids.update(connection.scalars(select(SiteMeasurementEntry.measurement_batch_id).where(
            SiteMeasurementEntry.measurement_item_id.in_(item_ids))))
    if batch_ids:
        connection = session.connection()
        list(connection.scalars(select(SiteMeasurementBatch.id).where(
            SiteMeasurementBatch.id.in_(batch_ids)).order_by(SiteMeasurementBatch.id).with_for_update()))
        invalidate_groups(connection, batch_ids)
