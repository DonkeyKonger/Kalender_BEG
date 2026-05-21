from datetime import datetime

from sqlalchemy import DateTime, Enum, Float, ForeignKey, Index, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin
from app.models.enums import GpsSourceType, enum_values


class GpsPoint(TimestampMixin, Base):
    __tablename__ = "gps_points"
    __table_args__ = (
        Index("ix_gps_points_source_timestamp", "source_type", "source_id", "timestamp"),
        Index("ix_gps_points_person_timestamp", "person_id", "timestamp"),
        Index("ix_gps_points_vehicle_timestamp", "vehicle_id", "timestamp"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    source_type: Mapped[GpsSourceType] = mapped_column(
        Enum(GpsSourceType, values_callable=enum_values, name="gps_source_type"),
        nullable=False,
    )
    source_id: Mapped[str] = mapped_column(String(120), nullable=False)
    person_id: Mapped[int | None] = mapped_column(ForeignKey("persons.id", ondelete="SET NULL"))
    vehicle_id: Mapped[int | None] = mapped_column(ForeignKey("vehicles.id", ondelete="SET NULL"))
    latitude: Mapped[float] = mapped_column(Float, nullable=False)
    longitude: Mapped[float] = mapped_column(Float, nullable=False)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    accuracy_m: Mapped[float | None] = mapped_column(Float)
