from datetime import date

from sqlalchemy import CheckConstraint, Date, ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class PersonWorkDay(TimestampMixin, Base):
    __tablename__ = "person_work_days"
    __table_args__ = (
        UniqueConstraint(
            "person_id",
            "work_date",
            name="uq_person_work_days_person_date",
        ),
        CheckConstraint(
            "overnight_status IS NULL OR overnight_status IN ('none', 'self_paid', 'beg_paid')",
            name="ck_person_work_days_overnight_status",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    person_id: Mapped[int] = mapped_column(
        ForeignKey("persons.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    work_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    overnight_status: Mapped[str | None] = mapped_column(String(32), nullable=True)

    person = relationship("Person")
