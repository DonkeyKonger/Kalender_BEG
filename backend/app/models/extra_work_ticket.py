from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    JSON,
    LargeBinary,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class ExtraWorkTicket(TimestampMixin, Base):
    __tablename__ = "extra_work_tickets"
    __table_args__ = (
        UniqueConstraint("site_id", "sequence_number", name="uq_extra_work_tickets_site_sequence"),
        CheckConstraint(
            "(manual_execution_week IS NULL AND manual_execution_week_year IS NULL) OR "
            "(manual_execution_week IS NOT NULL AND manual_execution_week_year IS NOT NULL)",
            name="ck_extra_work_ticket_manual_execution_week_pair",
        ),
        CheckConstraint(
            "manual_execution_week IS NULL OR manual_execution_week BETWEEN 1 AND 53",
            name="ck_extra_work_ticket_manual_execution_week_range",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    site_id: Mapped[int] = mapped_column(
        ForeignKey("sites.id", ondelete="CASCADE"), nullable=False, index=True
    )
    sequence_number: Mapped[int] = mapped_column(Integer, nullable=False)
    display_number: Mapped[str] = mapped_column(String(120), nullable=False)
    title: Mapped[str | None] = mapped_column(String(160))
    kind: Mapped[str] = mapped_column(String(40), nullable=False, default="billing", index=True)
    approval_ticket_id: Mapped[int | None] = mapped_column(
        ForeignKey("extra_work_tickets.id", ondelete="SET NULL"), index=True
    )
    status: Mapped[str] = mapped_column(String(40), nullable=False, default="draft", index=True)
    is_invoiced: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=False,
        server_default="false",
    )
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    submitted_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    notes: Mapped[str | None] = mapped_column(Text)
    customer_name: Mapped[str | None] = mapped_column(String(200))
    ordered_by_name: Mapped[str | None] = mapped_column(String(160))
    ordered_by_company: Mapped[str | None] = mapped_column(String(200))
    billing_type: Mapped[str | None] = mapped_column(String(32))
    estimated_order_value: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))
    material_required: Mapped[bool | None] = mapped_column(Boolean)
    material_separate_attachment: Mapped[bool | None] = mapped_column(Boolean, default=False)
    executed_by_lead_monteur: Mapped[bool | None] = mapped_column(Boolean)
    executed_by_monteur: Mapped[bool | None] = mapped_column(Boolean)
    executed_by_helper: Mapped[bool | None] = mapped_column(Boolean)
    executor_other_name: Mapped[str | None] = mapped_column(String(160))
    work_description: Mapped[str | None] = mapped_column(Text)
    manual_order_date: Mapped[date | None] = mapped_column(Date)
    manual_execution_week: Mapped[int | None] = mapped_column(Integer)
    manual_execution_week_year: Mapped[int | None] = mapped_column(Integer)
    manual_execution_start: Mapped[date | None] = mapped_column(Date)
    manual_execution_end: Mapped[date | None] = mapped_column(Date)
    customer_signature_type: Mapped[str | None] = mapped_column(String(60))
    customer_signature_name: Mapped[str | None] = mapped_column(String(160))
    customer_signature_place: Mapped[str | None] = mapped_column(String(160))
    customer_signature_strokes: Mapped[list[list[dict[str, float]]] | None] = mapped_column(JSON)
    customer_signed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    signed_pdf_content: Mapped[bytes | None] = mapped_column(LargeBinary, deferred=True)
    signed_pdf_filename: Mapped[str | None] = mapped_column(String(255))
    signed_pdf_sha256: Mapped[str | None] = mapped_column(String(64))
    signed_pdf_version: Mapped[str | None] = mapped_column(String(80))
    signed_photo_manifest: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    signed_snapshot_kind: Mapped[str | None] = mapped_column(String(48), index=True)
    signed_snapshot_created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    worker_signature_name: Mapped[str | None] = mapped_column(String(160))
    worker_signature_place: Mapped[str | None] = mapped_column(String(160))
    worker_signature_date: Mapped[date | None] = mapped_column(Date)
    worker_signature_strokes: Mapped[list[list[dict[str, float]]] | None] = mapped_column(JSON)
    worker_signed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    deleted_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )

    site = relationship("Site", back_populates="extra_work_tickets")
    approval_ticket = relationship("ExtraWorkTicket", remote_side=[id])
    entries = relationship(
        "ExtraWorkTicketEntry", back_populates="ticket", cascade="all, delete-orphan"
    )
    photos = relationship(
        "ExtraWorkTicketPhoto", back_populates="ticket", cascade="all, delete-orphan"
    )
    created_by = relationship("User", foreign_keys=[created_by_user_id])
    submitted_by = relationship("User", foreign_keys=[submitted_by_user_id])
    deleted_by = relationship("User", foreign_keys=[deleted_by_user_id])

    @property
    def entry_count(self) -> int:
        return len(self.entries or [])

    @property
    def photo_count(self) -> int:
        return len(self.photos or [])

    @property
    def total_hours(self) -> Decimal:
        total = Decimal("0")
        for entry in self.entries or []:
            total += entry.total_hours
        return total

    @property
    def estimated_hours(self) -> Decimal | None:
        values = [entry.estimated_hours for entry in self.entries or [] if entry.estimated_hours is not None]
        if not values:
            return None
        return sum(values, Decimal("0"))


class ExtraWorkTicketEntry(TimestampMixin, Base):
    __tablename__ = "extra_work_ticket_entries"

    id: Mapped[int] = mapped_column(primary_key=True)
    ticket_id: Mapped[int] = mapped_column(
        ForeignKey("extra_work_tickets.id", ondelete="CASCADE"), nullable=False, index=True
    )
    site_id: Mapped[int] = mapped_column(
        ForeignKey("sites.id", ondelete="CASCADE"), nullable=False, index=True
    )
    component: Mapped[str] = mapped_column(String(160), nullable=False)
    floor: Mapped[str] = mapped_column(String(120), nullable=False)
    room_number: Mapped[str | None] = mapped_column(String(80))
    axis: Mapped[str | None] = mapped_column(String(80))
    remarks: Mapped[str | None] = mapped_column(Text)
    material_text: Mapped[str | None] = mapped_column(Text)
    material_items: Mapped[list[dict[str, Any]] | None] = mapped_column(JSON)
    estimated_hours: Mapped[Decimal | None] = mapped_column(Numeric(10, 2))
    worker_rows: Mapped[list[dict[str, Any]]] = mapped_column(JSON, nullable=False, default=list)
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )

    ticket = relationship("ExtraWorkTicket", back_populates="entries")
    site = relationship("Site")
    created_by = relationship("User")

    @property
    def total_hours(self) -> Decimal:
        total = Decimal("0")
        for row in self.worker_rows or []:
            for weekday in (
                "monday",
                "tuesday",
                "wednesday",
                "thursday",
                "friday",
                "saturday",
                "sunday",
            ):
                keys = (
                    f"{weekday}_hours",
                    f"{weekday}_surcharge_25_hours",
                    f"{weekday}_surcharge_50_hours",
                )
                for key in keys:
                    try:
                        total += Decimal(str(row.get(key) or 0))
                    except (ArithmeticError, TypeError, ValueError):
                        continue
        return total


class ExtraWorkTicketPhoto(TimestampMixin, Base):
    __tablename__ = "extra_work_ticket_photos"

    id: Mapped[int] = mapped_column(primary_key=True)
    site_id: Mapped[int] = mapped_column(
        ForeignKey("sites.id", ondelete="CASCADE"), nullable=False, index=True
    )
    extra_work_ticket_id: Mapped[int] = mapped_column(
        ForeignKey("extra_work_tickets.id", ondelete="CASCADE"), nullable=False, index=True
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
    thumbnail_content: Mapped[bytes | None] = mapped_column(LargeBinary, deferred=True)
    thumbnail_content_type: Mapped[str | None] = mapped_column(String(120))
    caption: Mapped[str | None] = mapped_column(String(500))
    taken_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    customer_document_selected: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=True,
        server_default="true",
    )
    content_sha256: Mapped[str | None] = mapped_column(String(64))

    ticket = relationship("ExtraWorkTicket", back_populates="photos")
    site = relationship("Site")
    uploaded_by = relationship("User")
