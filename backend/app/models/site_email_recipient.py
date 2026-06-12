from sqlalchemy import Boolean, ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class SiteEmailRecipient(TimestampMixin, Base):
    __tablename__ = "site_email_recipients"
    __table_args__ = (
        UniqueConstraint("site_id", "email", name="uq_site_email_recipients_site_email"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    site_id: Mapped[int] = mapped_column(
        ForeignKey("sites.id", ondelete="CASCADE"), nullable=False, index=True
    )
    email: Mapped[str] = mapped_column(String(255), nullable=False)
    label: Mapped[str | None] = mapped_column(String(200))
    source: Mapped[str | None] = mapped_column(String(80))
    is_selected: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    site = relationship("Site", back_populates="email_recipients")
