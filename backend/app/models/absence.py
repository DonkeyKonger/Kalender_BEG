from datetime import date

from sqlalchemy import Date, Enum, ForeignKey, Index, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin
from app.models.enums import AbsenceStatus, AbsenceType, enum_values


class Absence(TimestampMixin, Base):
    __tablename__ = "absences"
    __table_args__ = (
        Index("ix_absences_person_date_range", "person_id", "start_date", "end_date"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    person_id: Mapped[int] = mapped_column(
        ForeignKey("persons.id", ondelete="CASCADE"),
        nullable=False,
    )
    absence_type: Mapped[AbsenceType] = mapped_column(
        Enum(AbsenceType, values_callable=enum_values, name="absence_type"),
        nullable=False,
    )
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date] = mapped_column(Date, nullable=False)
    status: Mapped[AbsenceStatus] = mapped_column(
        Enum(AbsenceStatus, values_callable=enum_values, name="absence_status"),
        nullable=False,
        default=AbsenceStatus.ACTIVE,
    )
    note: Mapped[str | None] = mapped_column(Text)
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )
    updated_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )

    person = relationship("Person", back_populates="absences")
