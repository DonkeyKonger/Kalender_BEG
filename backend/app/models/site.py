from datetime import datetime

from sqlalchemy import DateTime, Enum, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin
from app.models.enums import SiteStatus, enum_values


class Site(TimestampMixin, Base):
    __tablename__ = "sites"

    id: Mapped[int] = mapped_column(primary_key=True)
    site_number: Mapped[str | None] = mapped_column(String(80), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False, index=True)
    location: Mapped[str | None] = mapped_column(String(200))
    address: Mapped[str | None] = mapped_column(String(500))
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
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    closed_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL")
    )

    project_manager = relationship("Person")
    assignments = relationship("Assignment", back_populates="site")
