from sqlalchemy import Float, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class ProjectFolderCount(Base):
    __tablename__ = "project_folder_counts"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    site_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    file_count: Mapped[int | None] = mapped_column(Integer)
    checked_at: Mapped[float | None] = mapped_column(Float)
    retry_after: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    token: Mapped[str | None] = mapped_column(String(36))
