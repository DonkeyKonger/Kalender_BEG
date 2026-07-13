from datetime import date, datetime

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Index, Integer, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class DashboardNote(TimestampMixin, Base):
    __tablename__ = "dashboard_notes"
    __table_args__ = (
        Index("ix_dashboard_notes_completed_due", "completed", "due_date"),
        Index(
            "ix_dashboard_notes_owner_open_site",
            "created_by_user_id",
            "completed",
            "deleted_at",
            "site_id",
        ),
        Index(
            "ix_dashboard_notes_shared_open_site",
            "shared_with_user_id",
            "completed",
            "deleted_at",
            "site_id",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    due_date: Mapped[date | None] = mapped_column(Date)
    completed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    site_id: Mapped[int | None] = mapped_column(ForeignKey("sites.id", ondelete="SET NULL"), index=True)
    employee_id: Mapped[int | None] = mapped_column(ForeignKey("persons.id", ondelete="SET NULL"), index=True)
    created_by_user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    shared_with_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    share_revision: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    shared_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    deleted_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))

    site = relationship("Site")
    employee = relationship("Person")
    created_by = relationship("User", foreign_keys=[created_by_user_id])
    shared_with = relationship("User", foreign_keys=[shared_with_user_id])
    deleted_by = relationship("User", foreign_keys=[deleted_by_user_id])
