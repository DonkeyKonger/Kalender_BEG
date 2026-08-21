from sqlalchemy import Boolean, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class ProjectFolder(TimestampMixin, Base):
    __tablename__ = "project_folders"
    __table_args__ = (UniqueConstraint("site_id", "folder_key", name="uq_project_folders_site_key"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    site_id: Mapped[int] = mapped_column(ForeignKey("sites.id", ondelete="CASCADE"), nullable=False, index=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    folder_key: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    external_provider: Mapped[str | None] = mapped_column(String(80))
    external_drive_id: Mapped[str | None] = mapped_column(String(200))
    external_item_id: Mapped[str | None] = mapped_column(String(200))
    external_web_url: Mapped[str | None] = mapped_column(String(500))

    site = relationship("Site", back_populates="project_folders")


class ProjectFolderDocumentCaption(TimestampMixin, Base):
    __tablename__ = "project_folder_document_captions"
    __table_args__ = (
        UniqueConstraint(
            "site_id",
            "folder_key",
            "external_item_id",
            name="uq_project_folder_document_caption_item",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    site_id: Mapped[int] = mapped_column(
        ForeignKey("sites.id", ondelete="CASCADE"), nullable=False, index=True
    )
    folder_key: Mapped[str] = mapped_column(String(80), nullable=False)
    external_item_id: Mapped[str] = mapped_column(String(255), nullable=False)
    caption: Mapped[str | None] = mapped_column(String(500))
