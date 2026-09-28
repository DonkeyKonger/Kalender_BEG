from sqlalchemy import ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class ProjectManagerFolder(Base):
    """Stable OneDrive identity, scoped to a drive and active/archive parent."""

    __tablename__ = "project_manager_folders"
    __table_args__ = (
        UniqueConstraint("person_id", "drive_id", "parent_folder_id", name="uq_manager_folder_scope"),
        UniqueConstraint("drive_id", "folder_id", name="uq_manager_folder_item"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    person_id: Mapped[int] = mapped_column(ForeignKey("persons.id"), index=True)
    drive_id: Mapped[str] = mapped_column(String(255))
    parent_folder_id: Mapped[str] = mapped_column(String(255))
    folder_id: Mapped[str] = mapped_column(String(255))

