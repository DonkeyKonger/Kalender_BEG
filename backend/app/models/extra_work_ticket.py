from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
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

    site = relationship("Site", back_populates="extra_work_tickets")
    approval_ticket = relationship("ExtraWorkTicket", remote_side=[id])
    created_by = relationship("User", foreign_keys=[created_by_user_id])
    submitted_by = relationship("User", foreign_keys=[submitted_by_user_id])
