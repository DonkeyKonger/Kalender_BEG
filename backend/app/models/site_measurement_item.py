from decimal import Decimal

from sqlalchemy import Boolean, ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class SiteMeasurementItem(TimestampMixin, Base):
    __tablename__ = "site_measurement_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    site_id: Mapped[int] = mapped_column(
        ForeignKey("sites.id", ondelete="CASCADE"), nullable=False, index=True
    )
    source_file_name: Mapped[str | None] = mapped_column(String(255))
    source_project_number: Mapped[str | None] = mapped_column(String(120))
    source_invoice_number: Mapped[str | None] = mapped_column(String(120), index=True)
    source_customer_name: Mapped[str | None] = mapped_column(String(255))
    position: Mapped[str] = mapped_column(String(80), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    list_quantity: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    unit: Mapped[str | None] = mapped_column(String(40))
    minutes_per_unit: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    list_minutes_total: Mapped[Decimal | None] = mapped_column(Numeric(14, 2))
    is_nep: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False)

    site = relationship("Site", back_populates="measurement_items")
    entries = relationship(
        "SiteMeasurementEntry", back_populates="measurement_item", cascade="all, delete-orphan"
    )


class SiteMeasurementEntry(TimestampMixin, Base):
    __tablename__ = "site_measurement_entries"

    id: Mapped[int] = mapped_column(primary_key=True)
    measurement_item_id: Mapped[int] = mapped_column(
        ForeignKey("site_measurement_items.id", ondelete="CASCADE"), nullable=False, index=True
    )
    site_id: Mapped[int] = mapped_column(
        ForeignKey("sites.id", ondelete="CASCADE"), nullable=False, index=True
    )
    quantity: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    area_or_comment: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(40), nullable=False, default="saved")
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )

    measurement_item = relationship("SiteMeasurementItem", back_populates="entries")
    site = relationship("Site", back_populates="measurement_entries")
    created_by = relationship("User")
