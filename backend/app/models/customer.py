from datetime import datetime

from sqlalchemy import Boolean, DateTime, Enum, Float, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin
from app.models.enums import SiteLocationStatus, enum_values


class Customer(TimestampMixin, Base):
    __tablename__ = "customers"

    id: Mapped[int] = mapped_column(primary_key=True)
    company_name: Mapped[str] = mapped_column(String(200), nullable=False, index=True)
    address_street: Mapped[str | None] = mapped_column(String(200))
    address_house_number: Mapped[str | None] = mapped_column(String(40))
    address_postal_code: Mapped[str | None] = mapped_column(String(20))
    address_city: Mapped[str | None] = mapped_column(String(120))
    address_country: Mapped[str | None] = mapped_column(String(120), default="Deutschland")
    address_extra: Mapped[str | None] = mapped_column(String(200))
    address_formatted: Mapped[str | None] = mapped_column(String(500))
    address_latitude: Mapped[float | None] = mapped_column(Float)
    address_longitude: Mapped[float | None] = mapped_column(Float)
    address_location_status: Mapped[SiteLocationStatus] = mapped_column(
        Enum(SiteLocationStatus, values_callable=enum_values, name="site_location_status"),
        nullable=False,
        default=SiteLocationStatus.UNCHECKED,
    )
    company_phone: Mapped[str | None] = mapped_column(String(80))
    project_lead_name: Mapped[str | None] = mapped_column(String(200))
    project_lead_phone: Mapped[str | None] = mapped_column(String(80))
    project_lead_email: Mapped[str | None] = mapped_column(String(255))
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, index=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    deleted_by: Mapped[int | None] = mapped_column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    deleted_tombstone_id: Mapped[str | None] = mapped_column(String(255), unique=True, index=True)

    contacts = relationship(
        "CustomerContact",
        back_populates="customer",
        cascade="all, delete-orphan",
        order_by="CustomerContact.id",
    )

class CustomerContact(TimestampMixin, Base):
    __tablename__ = "customer_contacts"

    id: Mapped[int] = mapped_column(primary_key=True)
    customer_id: Mapped[int] = mapped_column(
        ForeignKey("customers.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    contact_type: Mapped[str | None] = mapped_column(String(40))
    name: Mapped[str | None] = mapped_column(String(200))
    phone: Mapped[str | None] = mapped_column(String(80))
    email: Mapped[str | None] = mapped_column(String(255))

    customer = relationship("Customer", back_populates="contacts")
