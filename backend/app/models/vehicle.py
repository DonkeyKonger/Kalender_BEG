from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
    UniqueConstraint,
    func,
)
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


class VehicleAsset(TimestampMixin, Base):
    __tablename__ = "vehicle_assets"
    __table_args__ = (
        UniqueConstraint("source", "external_id", name="uq_vehicle_assets_source_external_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    assigned_person_id: Mapped[int | None] = mapped_column(
        ForeignKey("persons.id", ondelete="SET NULL"),
        unique=True,
        index=True,
    )
    source: Mapped[str] = mapped_column(String(40), nullable=False, default="ctrack", index=True)
    external_id: Mapped[str] = mapped_column(String(120), nullable=False)
    ctrack_node_id: Mapped[int | None] = mapped_column(Integer)
    label: Mapped[str | None] = mapped_column(String(160))
    vehicle_registration: Mapped[str | None] = mapped_column(String(80))
    fleet_number: Mapped[str | None] = mapped_column(String(80))
    description: Mapped[str | None] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    raw_payload: Mapped[dict[str, Any] | list[Any] | None] = mapped_column(JSON)

    assigned_person = relationship("Person")

    position_logs = relationship(
        "VehiclePositionLog",
        back_populates="vehicle_asset",
        cascade="all, delete-orphan",
    )
    latest_position = relationship(
        "VehicleLatestPosition",
        back_populates="vehicle_asset",
        cascade="all, delete-orphan",
        uselist=False,
    )


class VehiclePositionLog(Base):
    __tablename__ = "vehicle_position_logs"
    __table_args__ = (
        UniqueConstraint(
            "vehicle_asset_id",
            "event_time_utc",
            "source",
            name="uq_vehicle_position_logs_asset_time_source",
        ),
        Index("ix_vehicle_position_logs_event_time_utc", "event_time_utc"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    vehicle_asset_id: Mapped[int] = mapped_column(
        ForeignKey("vehicle_assets.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    source: Mapped[str] = mapped_column(String(40), nullable=False, default="ctrack", index=True)
    external_id: Mapped[str | None] = mapped_column(String(160))
    event_time_utc: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    latitude: Mapped[float] = mapped_column(Float, nullable=False)
    longitude: Mapped[float] = mapped_column(Float, nullable=False)
    speed: Mapped[float | None] = mapped_column(Float)
    ignition: Mapped[bool | None] = mapped_column(Boolean)
    odometer: Mapped[float | None] = mapped_column(Float)
    heading_text: Mapped[str | None] = mapped_column(String(120))
    driver_id: Mapped[str | None] = mapped_column(String(120))
    driver_name: Mapped[str | None] = mapped_column(String(160))
    location_text: Mapped[str | None] = mapped_column(Text)
    raw_payload: Mapped[dict[str, Any] | list[Any] | None] = mapped_column(JSON)

    vehicle_asset = relationship("VehicleAsset", back_populates="position_logs")


class VehicleLatestPosition(Base):
    __tablename__ = "vehicle_latest_positions"
    __table_args__ = (
        Index("ix_vehicle_latest_positions_event_time_utc", "event_time_utc"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    vehicle_asset_id: Mapped[int] = mapped_column(
        ForeignKey("vehicle_assets.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
        index=True,
    )
    event_time_utc: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    latitude: Mapped[float] = mapped_column(Float, nullable=False)
    longitude: Mapped[float] = mapped_column(Float, nullable=False)
    speed: Mapped[float | None] = mapped_column(Float)
    ignition: Mapped[bool | None] = mapped_column(Boolean)
    odometer: Mapped[float | None] = mapped_column(Float)
    driver_id: Mapped[str | None] = mapped_column(String(120))
    driver_name: Mapped[str | None] = mapped_column(String(160))
    location_text: Mapped[str | None] = mapped_column(Text)
    source: Mapped[str] = mapped_column(String(40), nullable=False, default="ctrack", index=True)
    raw_payload: Mapped[dict[str, Any] | list[Any] | None] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    vehicle_asset = relationship("VehicleAsset", back_populates="latest_position")
