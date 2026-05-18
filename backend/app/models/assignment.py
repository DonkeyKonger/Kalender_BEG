from datetime import date

from sqlalchemy import Date, Enum, ForeignKey, Index, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin
from app.models.enums import AssignmentType, enum_values


class Assignment(TimestampMixin, Base):
    __tablename__ = "assignments"
    __table_args__ = (
        Index("ix_assignments_person_date_range", "person_id", "start_date", "end_date"),
        Index("ix_assignments_site_date_range", "site_id", "start_date", "end_date"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    site_id: Mapped[int] = mapped_column(ForeignKey("sites.id", ondelete="CASCADE"), nullable=False)
    person_id: Mapped[int] = mapped_column(
        ForeignKey("persons.id", ondelete="RESTRICT"),
        nullable=False,
    )
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date] = mapped_column(Date, nullable=False)
    assignment_type: Mapped[AssignmentType] = mapped_column(
        Enum(AssignmentType, values_callable=enum_values, name="assignment_type"),
        nullable=False,
        default=AssignmentType.REGULAR,
    )
    note: Mapped[str | None] = mapped_column(Text)
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    updated_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )

    site = relationship("Site", back_populates="assignments")
    person = relationship("Person", back_populates="assignments")
