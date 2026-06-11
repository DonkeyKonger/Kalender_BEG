from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import DateTime, ForeignKey, Integer, JSON, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class ExtraWorkTicket(TimestampMixin, Base):
    __tablename__ = "extra_work_tickets"
    __table_args__ = (
        UniqueConstraint("site_id", "sequence_number", name="uq_extra_work_tickets_site_sequence"),
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
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    submitted_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    notes: Mapped[str | None] = mapped_column(Text)
    customer_signature_type: Mapped[str | None] = mapped_column(String(60))
    customer_signature_name: Mapped[str | None] = mapped_column(String(160))
    customer_signature_place: Mapped[str | None] = mapped_column(String(160))
    customer_signature_strokes: Mapped[list[list[dict[str, float]]] | None] = mapped_column(JSON)
    customer_signed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    worker_signature_name: Mapped[str | None] = mapped_column(String(160))
    worker_signature_strokes: Mapped[list[list[dict[str, float]]] | None] = mapped_column(JSON)
    worker_signed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

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

    @property
    def entry_count(self) -> int:
        return len(self.entries or [])

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
            for key in (
                "monday_hours",
                "tuesday_hours",
                "wednesday_hours",
                "thursday_hours",
                "friday_hours",
                "saturday_hours",
                "sunday_hours",
            ):
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
    caption: Mapped[str | None] = mapped_column(String(500))
    taken_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    ticket = relationship("ExtraWorkTicket", back_populates="photos")
    site = relationship("Site")
    uploaded_by = relationship("User")
