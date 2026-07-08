from sqlalchemy import ForeignKey, Index, Integer, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class PersonHoursAccountEntry(TimestampMixin, Base):
    __tablename__ = "person_hours_account_entries"
    __table_args__ = (
        Index("ix_person_hours_account_entries_person_created", "person_id", "created_at"),
        Index("ix_person_hours_account_entries_week", "person_id", "iso_year", "iso_week"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    person_id: Mapped[int] = mapped_column(
        ForeignKey("persons.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    entry_type: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    minutes_delta: Mapped[int] = mapped_column(Integer, nullable=False)
    balance_after_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    note: Mapped[str] = mapped_column(Text, nullable=False)
    iso_year: Mapped[int | None] = mapped_column(Integer)
    iso_week: Mapped[int | None] = mapped_column(Integer)
    weekly_review_id: Mapped[int | None] = mapped_column(
        ForeignKey("time_entry_weekly_reviews.id", ondelete="SET NULL"),
        index=True,
    )
    weekly_work_minutes: Mapped[int | None] = mapped_column(Integer)
    weekly_actual_minutes: Mapped[int | None] = mapped_column(Integer)
    weekly_required_minutes: Mapped[int | None] = mapped_column(Integer)
    weekly_overtime_absence_minutes: Mapped[int | None] = mapped_column(Integer)
    weekly_absence_breakdown: Mapped[list[dict] | None] = mapped_column(JSON)
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"),
        index=True,
    )

    person = relationship("Person", back_populates="hours_account_entries")
    weekly_review = relationship("TimeEntryWeeklyReview")
    created_by = relationship("User")
