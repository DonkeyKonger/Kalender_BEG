from datetime import date, time

from sqlalchemy import CheckConstraint, Date, ForeignKey, Index, Text, Time
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class OperationalAbsence(TimestampMixin, Base):
    """Operational information only; deliberately separate from HR absences."""

    __tablename__ = "operational_absences"
    __table_args__ = (
        Index(
            "ix_operational_absences_date_project_manager",
            "absence_date",
            "project_manager_id",
        ),
        CheckConstraint(
            "(start_time IS NULL AND end_time IS NULL) OR "
            "(start_time IS NOT NULL AND end_time IS NOT NULL AND end_time > start_time)",
            name="ck_operational_absences_time_range",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    project_manager_id: Mapped[int] = mapped_column(
        ForeignKey("persons.id", ondelete="RESTRICT"),
        nullable=False,
    )
    absence_date: Mapped[date] = mapped_column(Date, nullable=False)
    start_time: Mapped[time | None] = mapped_column(Time, nullable=True)
    end_time: Mapped[time | None] = mapped_column(Time, nullable=True)
    site_id: Mapped[int | None] = mapped_column(
        ForeignKey("sites.id", ondelete="SET NULL"),
        nullable=True,
    )
    text: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )

    project_manager = relationship("Person")
    site = relationship("Site")
    created_by = relationship("User")
