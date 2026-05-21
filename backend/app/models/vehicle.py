from datetime import date

from sqlalchemy import Boolean, Date, Enum, ForeignKey, Index, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin
from app.models.enums import VehicleType, enum_values


class Vehicle(TimestampMixin, Base):
    __tablename__ = "vehicles"

    id: Mapped[int] = mapped_column(primary_key=True)
    license_plate: Mapped[str] = mapped_column(String(30), nullable=False, unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    vehicle_type: Mapped[VehicleType] = mapped_column(
        Enum(VehicleType, values_callable=enum_values, name="vehicle_type"),
        nullable=False,
        default=VehicleType.VAN,
    )
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    gps_vehicle_id: Mapped[str | None] = mapped_column(String(120))
    gps_device_id: Mapped[str | None] = mapped_column(String(120))
    notes: Mapped[str | None] = mapped_column(Text)

    site_assignments = relationship("SiteVehicleAssignment", back_populates="vehicle")


class SiteVehicleAssignment(TimestampMixin, Base):
    __tablename__ = "site_vehicle_assignments"
    __table_args__ = (
        Index("ix_site_vehicle_assignments_date_range", "vehicle_id", "start_date", "end_date"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    site_id: Mapped[int] = mapped_column(ForeignKey("sites.id", ondelete="CASCADE"), nullable=False)
    vehicle_id: Mapped[int] = mapped_column(
        ForeignKey("vehicles.id", ondelete="CASCADE"),
        nullable=False,
    )
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date] = mapped_column(Date, nullable=False)
    note: Mapped[str | None] = mapped_column(Text)

    vehicle = relationship("Vehicle", back_populates="site_assignments")
