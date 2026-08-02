from datetime import date, datetime, time

from sqlalchemy import Date, DateTime, ForeignKey, Index, Integer, String, Text, Time
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class WorkTimeEntry(TimestampMixin, Base):
    __tablename__ = "work_time_entries"
    __table_args__ = (
        Index("ix_work_time_entries_person_date", "person_id", "work_date"),
        Index("ix_work_time_entries_site_date", "site_id", "work_date"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    person_id: Mapped[int] = mapped_column(
        ForeignKey("persons.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    site_id: Mapped[int | None] = mapped_column(
        ForeignKey("sites.id", ondelete="SET NULL"),
        index=True,
    )
    original_site_id: Mapped[int | None] = mapped_column(
        ForeignKey("sites.id", ondelete="SET NULL"),
        index=True,
    )
    assignment_id: Mapped[int | None] = mapped_column(
        ForeignKey("assignments.id", ondelete="SET NULL"),
        index=True,
    )
    work_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    original_work_date: Mapped[date | None] = mapped_column(Date)
    start_time: Mapped[time | None] = mapped_column(Time)
    end_time: Mapped[time | None] = mapped_column(Time)
    break_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    travel_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    work_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    original_work_minutes: Mapped[int | None] = mapped_column(Integer)
    corrected_work_minutes: Mapped[int | None] = mapped_column(Integer)
    payroll_corrected_start_time: Mapped[time | None] = mapped_column(Time)
    payroll_corrected_end_time: Mapped[time | None] = mapped_column(Time)
    payroll_corrected_break_minutes: Mapped[int | None] = mapped_column(Integer)
    payroll_corrected_work_minutes: Mapped[int | None] = mapped_column(Integer)
    note: Mapped[str | None] = mapped_column(Text)
    source: Mapped[str] = mapped_column(String(40), nullable=False, default="manual")
    status: Mapped[str] = mapped_column(String(40), nullable=False, default="draft")
    time_review_status: Mapped[str] = mapped_column(String(40), nullable=False, default="open")
    time_review_method: Mapped[str | None] = mapped_column(String(40))
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"),
        index=True,
    )
    reviewed_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"),
        index=True,
    )
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    payroll_reviewed_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"),
        index=True,
    )
    payroll_reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    person = relationship("Person")
    site = relationship("Site", foreign_keys=[site_id])
    original_site = relationship("Site", foreign_keys=[original_site_id])
    assignment = relationship("Assignment")
    created_by = relationship("User", foreign_keys=[created_by_user_id])
    reviewed_by = relationship("User", foreign_keys=[reviewed_by_user_id])
    payroll_reviewed_by = relationship("User", foreign_keys=[payroll_reviewed_by_user_id])
