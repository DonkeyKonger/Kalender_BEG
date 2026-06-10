from datetime import datetime

from sqlalchemy import DateTime, Enum, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.geofence import DEFAULT_SITE_GEOFENCE_RADIUS_M
from app.models.base import Base, TimestampMixin
from app.models.enums import SiteLocationStatus, SiteStatus, enum_values


class Site(TimestampMixin, Base):
    __tablename__ = "sites"

    id: Mapped[int] = mapped_column(primary_key=True)
    site_number: Mapped[str | None] = mapped_column(String(80), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False, index=True)
    location: Mapped[str | None] = mapped_column(String(200))
    address: Mapped[str | None] = mapped_column(String(500))
    postal_code: Mapped[str | None] = mapped_column(String(20))
    city: Mapped[str | None] = mapped_column(String(120))
    street: Mapped[str | None] = mapped_column(String(200))
    house_number: Mapped[str | None] = mapped_column(String(40))
    address_extra: Mapped[str | None] = mapped_column(String(200))
    latitude: Mapped[float | None] = mapped_column(Float)
    longitude: Mapped[float | None] = mapped_column(Float)
    geofence_radius_m: Mapped[int] = mapped_column(Integer, nullable=False, default=DEFAULT_SITE_GEOFENCE_RADIUS_M)
    location_status: Mapped[SiteLocationStatus] = mapped_column(
        Enum(SiteLocationStatus, values_callable=enum_values, name="site_location_status"),
        nullable=False,
        default=SiteLocationStatus.UNCHECKED,
    )
    customer: Mapped[str | None] = mapped_column(String(200))
    project_manager_person_id: Mapped[int | None] = mapped_column(
        ForeignKey("persons.id", ondelete="SET NULL")
    )
    status: Mapped[SiteStatus] = mapped_column(
        Enum(SiteStatus, values_callable=enum_values, name="site_status"),
        nullable=False,
        default=SiteStatus.ACTIVE,
        index=True,
    )
    info: Mapped[str | None] = mapped_column(Text)
    color: Mapped[str | None] = mapped_column(String(30))
    planned_work_minutes: Mapped[int | None] = mapped_column(Integer)
    project_folder_id: Mapped[str | None] = mapped_column(String(200))
    project_folder_web_url: Mapped[str | None] = mapped_column(String(500))
    project_folder_name: Mapped[str | None] = mapped_column(String(200))
    project_folder_status: Mapped[str] = mapped_column(String(40), nullable=False, default="not_configured")
    project_folder_error: Mapped[str | None] = mapped_column(Text)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    closed_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )

    project_manager = relationship("Person")
    assignments = relationship("Assignment", back_populates="site")
    project_folders = relationship("ProjectFolder", back_populates="site", cascade="all, delete-orphan")
    measurement_bases = relationship(
        "SiteMeasurementBase", back_populates="site", cascade="all, delete-orphan"
    )
    measurement_items = relationship(
        "SiteMeasurementItem", back_populates="site", cascade="all, delete-orphan"
    )
    measurement_batches = relationship(
        "SiteMeasurementBatch", back_populates="site", cascade="all, delete-orphan"
    )
    measurement_entries = relationship(
        "SiteMeasurementEntry", back_populates="site", cascade="all, delete-orphan"
    )
    extra_work_tickets = relationship(
        "ExtraWorkTicket", back_populates="site", cascade="all, delete-orphan"
    )
