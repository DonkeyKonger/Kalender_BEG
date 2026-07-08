from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class TimeEntryWeeklyReview(TimestampMixin, Base):
    __tablename__ = "time_entry_weekly_reviews"
    __table_args__ = (
        UniqueConstraint("person_id", "iso_year", "iso_week", name="uq_time_entry_weekly_reviews_person_week"),
        Index("ix_time_entry_weekly_reviews_week", "iso_year", "iso_week"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    person_id: Mapped[int] = mapped_column(
        ForeignKey("persons.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    iso_year: Mapped[int] = mapped_column(Integer, nullable=False)
    iso_week: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(40), nullable=False, default="reviewed")
    reviewed_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"),
        index=True,
    )
    reviewed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    person = relationship("Person")
    reviewed_by = relationship("User")
