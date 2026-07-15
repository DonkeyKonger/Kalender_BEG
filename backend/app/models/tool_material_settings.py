from sqlalchemy import CheckConstraint, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class ToolMaterialSettings(TimestampMixin, Base):
    __tablename__ = "tool_material_settings"
    __table_args__ = (
        CheckConstraint("id = 1", name="ck_tool_material_settings_singleton"),
    )

    id: Mapped[int] = mapped_column(primary_key=True, default=1)
    tool_responsible_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )

    tool_responsible_user = relationship("User", foreign_keys=[tool_responsible_user_id])
