"""Track resolved tool issue reports.

Revision ID: 20260717_0089
Revises: 20260717_0088
Create Date: 2026-07-17
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260717_0089"
down_revision: str | None = "20260717_0088"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "tool_issue_reports",
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "tool_issue_reports",
        sa.Column("resolved_by_user_id", sa.Integer(), nullable=True),
    )
    op.create_index(
        "ix_tool_issue_reports_resolved_at",
        "tool_issue_reports",
        ["resolved_at"],
        unique=False,
    )
    op.create_index(
        "ix_tool_issue_reports_resolved_by_user_id",
        "tool_issue_reports",
        ["resolved_by_user_id"],
        unique=False,
    )
    op.create_foreign_key(
        "fk_tool_issue_reports_resolved_by_user_id",
        "tool_issue_reports",
        "users",
        ["resolved_by_user_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_tool_issue_reports_resolved_by_user_id",
        "tool_issue_reports",
        type_="foreignkey",
    )
    op.drop_index(
        "ix_tool_issue_reports_resolved_by_user_id",
        table_name="tool_issue_reports",
    )
    op.drop_index("ix_tool_issue_reports_resolved_at", table_name="tool_issue_reports")
    op.drop_column("tool_issue_reports", "resolved_by_user_id")
    op.drop_column("tool_issue_reports", "resolved_at")
