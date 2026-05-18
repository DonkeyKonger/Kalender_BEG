from sqlalchemy import Boolean, Enum, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin
from app.models.enums import PersonType, enum_values


class Person(TimestampMixin, Base):
    __tablename__ = "persons"

    id: Mapped[int] = mapped_column(primary_key=True)
    first_name: Mapped[str] = mapped_column(String(100), nullable=False)
    last_name: Mapped[str] = mapped_column(String(100), nullable=False)
    display_name: Mapped[str] = mapped_column(String(200), nullable=False)
    short_code: Mapped[str] = mapped_column(String(30), nullable=False, index=True)
    person_type: Mapped[PersonType] = mapped_column(
        Enum(PersonType, values_callable=enum_values, name="person_type"),
        nullable=False,
        default=PersonType.INTERNAL,
    )
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    email: Mapped[str | None] = mapped_column(String(255))
    phone: Mapped[str | None] = mapped_column(String(80))
    notes: Mapped[str | None] = mapped_column(Text)

    users = relationship("User", back_populates="person")
    assignments = relationship("Assignment", back_populates="person")
    absences = relationship("Absence", back_populates="person")
