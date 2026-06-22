from datetime import datetime
from decimal import Decimal

from typing import Any

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, JSON, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class SiteMeasurementBase(TimestampMixin, Base):
    __tablename__ = "site_measurement_bases"

    id: Mapped[int] = mapped_column(primary_key=True)
    site_id: Mapped[int] = mapped_column(
        ForeignKey("sites.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    base_type: Mapped[str | None] = mapped_column(String(40))
    status: Mapped[str] = mapped_column(String(40), nullable=False, default="active", index=True)
    released_to_mobile: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    source_note: Mapped[str | None] = mapped_column(Text)
    import_label: Mapped[str | None] = mapped_column(String(160))
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    site = relationship("Site", back_populates="measurement_bases")
    items = relationship(
        "SiteMeasurementItem", back_populates="measurement_base", cascade="all, delete-orphan"
    )
    batches = relationship(
        "SiteMeasurementBatch", back_populates="measurement_base", cascade="all, delete-orphan"
    )


class SiteMeasurementItem(TimestampMixin, Base):
    __tablename__ = "site_measurement_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    site_id: Mapped[int] = mapped_column(
        ForeignKey("sites.id", ondelete="CASCADE"), nullable=False, index=True
    )
    measurement_base_id: Mapped[int] = mapped_column(
        ForeignKey("site_measurement_bases.id", ondelete="CASCADE"), nullable=False, index=True
    )
    measurement_batch_id: Mapped[int | None] = mapped_column(
        ForeignKey("site_measurement_batches.id", ondelete="CASCADE"), index=True
    )
    source_file_name: Mapped[str | None] = mapped_column(String(255))
    source_project_number: Mapped[str | None] = mapped_column(String(120))
    source_invoice_number: Mapped[str | None] = mapped_column(String(120), index=True)
    source_customer_name: Mapped[str | None] = mapped_column(String(255))
    source_section_key: Mapped[str | None] = mapped_column(String(80))
    source_section_title: Mapped[str | None] = mapped_column(String(255))
    position: Mapped[str] = mapped_column(String(80), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    list_quantity: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    unit: Mapped[str | None] = mapped_column(String(40))
    minutes_per_unit: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    list_minutes_total: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    is_nep: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_free_position: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_hidden: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, index=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False)

    site = relationship("Site", back_populates="measurement_items")
    measurement_base = relationship("SiteMeasurementBase", back_populates="items")
    measurement_batch = relationship(
        "SiteMeasurementBatch",
        back_populates="free_items",
        foreign_keys=[measurement_batch_id],
    )
    entries = relationship(
        "SiteMeasurementEntry", back_populates="measurement_item", cascade="all, delete-orphan"
    )


class SiteMeasurementBatch(TimestampMixin, Base):
    __tablename__ = "site_measurement_batches"

    id: Mapped[int] = mapped_column(primary_key=True)
    site_id: Mapped[int] = mapped_column(
        ForeignKey("sites.id", ondelete="CASCADE"), nullable=False, index=True
    )
    measurement_base_id: Mapped[int] = mapped_column(
        ForeignKey("site_measurement_bases.id", ondelete="CASCADE"), nullable=False, index=True
    )
    number: Mapped[int] = mapped_column(Integer, nullable=False)
    title: Mapped[str] = mapped_column(String(120), nullable=False)
    status: Mapped[str] = mapped_column(String(40), nullable=False, default="draft", index=True)
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    submitted_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    original_submitted_snapshot: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    customer_signed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    customer_signature_name: Mapped[str | None] = mapped_column(String(160))
    customer_signature_place: Mapped[str | None] = mapped_column(String(260))
    customer_signature_strokes: Mapped[list[list[dict[str, float]]] | None] = mapped_column(JSON)
    customer_signed_snapshot: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    worker_signed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    worker_signature_name: Mapped[str | None] = mapped_column(String(160))
    worker_signature_strokes: Mapped[list[list[dict[str, float]]] | None] = mapped_column(JSON)

    site = relationship("Site", back_populates="measurement_batches")
    measurement_base = relationship("SiteMeasurementBase", back_populates="batches")
    entries = relationship(
        "SiteMeasurementEntry", back_populates="measurement_batch", cascade="all, delete-orphan"
    )
    free_items = relationship(
        "SiteMeasurementItem",
        back_populates="measurement_batch",
        cascade="all, delete-orphan",
        foreign_keys="SiteMeasurementItem.measurement_batch_id",
        order_by="SiteMeasurementItem.sort_order",
    )
    photos = relationship(
        "SiteMeasurementBatchPhoto", back_populates="measurement_batch", cascade="all, delete-orphan"
    )
    area_rows = relationship(
        "SiteMeasurementAreaRow",
        back_populates="measurement_batch",
        cascade="all, delete-orphan",
        order_by="SiteMeasurementAreaRow.sort_order",
    )
    created_by = relationship("User", foreign_keys=[created_by_user_id])
    submitted_by = relationship("User", foreign_keys=[submitted_by_user_id])


class SiteMeasurementAreaRow(TimestampMixin, Base):
    __tablename__ = "site_measurement_area_rows"

    id: Mapped[int] = mapped_column(primary_key=True)
    measurement_batch_id: Mapped[int] = mapped_column(
        ForeignKey("site_measurement_batches.id", ondelete="CASCADE"), nullable=False, index=True
    )
    site_id: Mapped[int] = mapped_column(
        ForeignKey("sites.id", ondelete="CASCADE"), nullable=False, index=True
    )
    area_or_comment: Mapped[str] = mapped_column(Text, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False)
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )

    measurement_batch = relationship("SiteMeasurementBatch", back_populates="area_rows")
    site = relationship("Site")
    created_by = relationship("User")


class SiteMeasurementEntry(TimestampMixin, Base):
    __tablename__ = "site_measurement_entries"

    id: Mapped[int] = mapped_column(primary_key=True)
    measurement_batch_id: Mapped[int] = mapped_column(
        ForeignKey("site_measurement_batches.id", ondelete="CASCADE"), nullable=False, index=True
    )
    measurement_item_id: Mapped[int] = mapped_column(
        ForeignKey("site_measurement_items.id", ondelete="CASCADE"), nullable=False, index=True
    )
    site_id: Mapped[int] = mapped_column(
        ForeignKey("sites.id", ondelete="CASCADE"), nullable=False, index=True
    )
    quantity: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    area_or_comment: Mapped[str] = mapped_column(Text, nullable=False)
    submitted_quantity: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    submitted_area_or_comment: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(40), nullable=False, default="saved")
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )

    measurement_batch = relationship("SiteMeasurementBatch", back_populates="entries")
    measurement_item = relationship("SiteMeasurementItem", back_populates="entries")
    site = relationship("Site", back_populates="measurement_entries")
    created_by = relationship("User")


class SiteMeasurementBatchPhoto(TimestampMixin, Base):
    __tablename__ = "site_measurement_batch_photos"

    id: Mapped[int] = mapped_column(primary_key=True)
    site_id: Mapped[int] = mapped_column(
        ForeignKey("sites.id", ondelete="CASCADE"), nullable=False, index=True
    )
    measurement_batch_id: Mapped[int] = mapped_column(
        ForeignKey("site_measurement_batches.id", ondelete="CASCADE"), nullable=False, index=True
    )
    uploaded_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    project_folder_key: Mapped[str] = mapped_column(String(80), nullable=False, default="fotos")
    external_drive_id: Mapped[str] = mapped_column(String(255), nullable=False)
    external_item_id: Mapped[str] = mapped_column(String(255), nullable=False)
    external_web_url: Mapped[str | None] = mapped_column(String(1000))
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[str] = mapped_column(String(120), nullable=False)
    file_size_bytes: Mapped[int | None] = mapped_column(Integer)
    caption: Mapped[str | None] = mapped_column(String(500))
    taken_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    measurement_batch = relationship("SiteMeasurementBatch", back_populates="photos")
    site = relationship("Site")
    uploaded_by = relationship("User")
