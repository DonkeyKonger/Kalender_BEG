from sqlalchemy import CheckConstraint, ForeignKey, Index, Integer, JSON, String, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class MaterialOrderDraft(TimestampMixin, Base):
    __tablename__ = "material_order_drafts"
    __table_args__ = (
        CheckConstraint("revision >= 0", name="ck_material_order_drafts_revision"),
        CheckConstraint(
            "status IN ('draft', 'completed')",
            name="ck_material_order_drafts_status",
        ),
        Index(
            "uq_material_order_drafts_open_site_user",
            "site_id",
            "user_id",
            unique=True,
            postgresql_where=text("status = 'draft'"),
            sqlite_where=text("status = 'draft'"),
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    site_id: Mapped[int] = mapped_column(
        ForeignKey("sites.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    values: Mapped[dict[str, str | bool]] = mapped_column(JSON, nullable=False, default=dict)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="draft", index=True)
    filename: Mapped[str | None] = mapped_column(String(255))
    completed_document: Mapped[dict | None] = mapped_column(JSON)
    completion_token: Mapped[str | None] = mapped_column(String(36))
    completion_filename: Mapped[str | None] = mapped_column(String(255))
    completion_payload_revision: Mapped[int | None] = mapped_column(Integer)

    site = relationship("Site")
    user = relationship("User")

    @property
    def completion_pending(self) -> bool:
        return self.status == "draft" and bool(self.completion_token)

    @property
    def document(self) -> dict | None:
        return self.completed_document
