from sqlalchemy import ForeignKey, Index, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class DashboardMessageDismissal(TimestampMixin, Base):
    __tablename__ = "dashboard_message_dismissals"
    __table_args__ = (
        UniqueConstraint("user_id", "message_key", name="uq_dashboard_message_dismissals_user_key"),
        Index("ix_dashboard_message_dismissals_user_type", "user_id", "message_type"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    message_type: Mapped[str] = mapped_column(String(80), nullable=False)
    message_key: Mapped[str] = mapped_column(String(160), nullable=False)

    user = relationship("User")
