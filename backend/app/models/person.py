from datetime import datetime

from sqlalchemy import Boolean, DateTime, Enum, Float, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin
from app.models.enums import PersonEmploymentStatus, PersonType, SiteLocationStatus, enum_values


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
    employment_status: Mapped[str] = mapped_column(
        String(20),
        nullable=False,
        default=PersonEmploymentStatus.ACTIVE.value,
    )
    annual_vacation_days: Mapped[int | None] = mapped_column(Integer)
    weekly_hours: Mapped[float | None] = mapped_column(Float)
    can_sign_measurements_immediately: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    email: Mapped[str | None] = mapped_column(String(255))
    phone: Mapped[str | None] = mapped_column(String(80))
    address_postal_code: Mapped[str | None] = mapped_column(String(20))
    address_city: Mapped[str | None] = mapped_column(String(120))
    address_street: Mapped[str | None] = mapped_column(String(200))
    address_house_number: Mapped[str | None] = mapped_column(String(40))
    address_extra: Mapped[str | None] = mapped_column(String(200))
    address_formatted: Mapped[str | None] = mapped_column(String(500))
    address_latitude: Mapped[float | None] = mapped_column(Float)
    address_longitude: Mapped[float | None] = mapped_column(Float)
    address_location_status: Mapped[SiteLocationStatus] = mapped_column(
        Enum(SiteLocationStatus, values_callable=enum_values, name="site_location_status"),
        nullable=False,
        default=SiteLocationStatus.UNCHECKED,
    )
    # Persistierte Altspalte der entfernten Handy-GPS-Funktion. Kein aktiver
    # Erfassungs-, Übertragungs- oder Auswertungspfad verwendet sie mehr.
    company_phone_device_id: Mapped[str | None] = mapped_column(String(120))
    notes: Mapped[str | None] = mapped_column(Text)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)

    users = relationship("User", back_populates="person")
    assignments = relationship("Assignment", back_populates="person")
    absences = relationship("Absence", back_populates="person")
    assigned_vehicles = relationship("Vehicle", back_populates="assigned_person")
    hours_account_entries = relationship(
        "PersonHoursAccountEntry",
        back_populates="person",
        cascade="all, delete-orphan",
    )
    weekly_schedules = relationship(
        "PersonWeeklySchedule",
        back_populates="person",
        order_by="PersonWeeklySchedule.valid_from",
    )
    hours_opening_balance = relationship(
        "PersonHoursOpeningBalance",
        back_populates="person",
        uselist=False,
    )
    vacation_carryovers = relationship(
        "PersonVacationCarryover",
        back_populates="person",
        cascade="all, delete-orphan",
    )
