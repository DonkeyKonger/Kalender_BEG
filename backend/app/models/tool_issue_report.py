from datetime import datetime

from sqlalchemy import DateTime, Enum, ForeignKey, Index, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin
from app.models.enums import ToolIssueReason, ToolIssueStatus, enum_values


class ToolIssueReport(TimestampMixin, Base):
    __tablename__ = "tool_issue_reports"
    __table_args__ = (
        UniqueConstraint("request_id", name="uq_tool_issue_reports_request_id"),
        Index("ix_tool_issue_reports_tool_status", "tool_id", "status"),
        Index("ix_tool_issue_reports_recipient_status", "recipient_user_id", "status"),
        Index("ix_tool_issue_reports_created_at", "created_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    tool_id: Mapped[int | None] = mapped_column(
        ForeignKey("tool_material_items.id", ondelete="SET NULL"), index=True
    )
    tool_id_snapshot: Mapped[int] = mapped_column(Integer, nullable=False)
    tool_beg_number_snapshot: Mapped[str | None] = mapped_column(String(120))
    tool_manufacturer_snapshot: Mapped[str | None] = mapped_column(String(200))
    tool_designation_snapshot: Mapped[str] = mapped_column(String(240), nullable=False)
    reason: Mapped[ToolIssueReason] = mapped_column(
        Enum(
            ToolIssueReason,
            values_callable=enum_values,
            name="tool_issue_reason",
            native_enum=False,
            create_constraint=True,
            validate_strings=True,
        ),
        nullable=False,
    )
    status: Mapped[ToolIssueStatus] = mapped_column(
        Enum(
            ToolIssueStatus,
            values_callable=enum_values,
            name="tool_issue_status",
            native_enum=False,
            create_constraint=True,
            validate_strings=True,
        ),
        nullable=False,
        default=ToolIssueStatus.OPEN,
        server_default=ToolIssueStatus.OPEN.value,
        index=True,
    )
    reporter_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    reporter_employee_id: Mapped[int | None] = mapped_column(
        ForeignKey("persons.id", ondelete="SET NULL"), index=True
    )
    reporter_last_name_snapshot: Mapped[str] = mapped_column(String(100), nullable=False)
    recipient_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    resolved_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    request_id: Mapped[str] = mapped_column(String(64), nullable=False)

    tool = relationship("ToolMaterialItem", back_populates="issue_reports")
    reporter_user = relationship("User", foreign_keys=[reporter_user_id])
    reporter_employee = relationship("Person", foreign_keys=[reporter_employee_id])
    recipient_user = relationship("User", foreign_keys=[recipient_user_id])
    resolved_by_user = relationship("User", foreign_keys=[resolved_by_user_id])

    @property
    def reporter_name(self) -> str:
        if self.reporter_employee is not None:
            return self.reporter_employee.display_name
        return self.reporter_last_name_snapshot
