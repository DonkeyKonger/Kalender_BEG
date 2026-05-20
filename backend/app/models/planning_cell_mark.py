from datetime import date

from sqlalchemy import Date, Enum, ForeignKey, Index, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin
from app.models.enums import MatrixCellMark, enum_values


class PlanningCellMark(TimestampMixin, Base):
    __tablename__ = "planning_cell_marks"
    __table_args__ = (
        UniqueConstraint("site_id", "mark_date", name="uq_planning_cell_marks_site_date"),
        Index("ix_planning_cell_marks_site_date", "site_id", "mark_date"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    site_id: Mapped[int] = mapped_column(ForeignKey("sites.id", ondelete="CASCADE"), nullable=False)
    mark_date: Mapped[date] = mapped_column(Date, nullable=False)
    mark: Mapped[MatrixCellMark] = mapped_column(
        Enum(MatrixCellMark, values_callable=enum_values, name="matrix_cell_mark"),
        nullable=False,
    )
    created_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    updated_by_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))

    site = relationship("Site")
