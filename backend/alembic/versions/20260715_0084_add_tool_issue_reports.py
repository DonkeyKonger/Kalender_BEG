"""Add structured tool issue reports.

Revision ID: 20260715_0084
Revises: 20260715_0083
Create Date: 2026-07-15
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260715_0084"
down_revision: str | None = "20260715_0083"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    connection = op.get_bind()
    if "tool_issue_reports" in set(sa.inspect(connection).get_table_names()):
        return
    op.create_table(
        "tool_issue_reports",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("tool_id", sa.Integer(), nullable=True),
        sa.Column("tool_id_snapshot", sa.Integer(), nullable=False),
        sa.Column("tool_beg_number_snapshot", sa.String(length=120), nullable=True),
        sa.Column("tool_manufacturer_snapshot", sa.String(length=200), nullable=True),
        sa.Column("tool_designation_snapshot", sa.String(length=240), nullable=False),
        sa.Column("reason", sa.String(length=9), nullable=False),
        sa.Column("status", sa.String(length=4), server_default="open", nullable=False),
        sa.Column("reporter_user_id", sa.Integer(), nullable=True),
        sa.Column("reporter_employee_id", sa.Integer(), nullable=True),
        sa.Column("reporter_last_name_snapshot", sa.String(length=100), nullable=False),
        sa.Column("recipient_user_id", sa.Integer(), nullable=True),
        sa.Column("request_id", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("reason IN ('DEFECTIVE', 'STOLEN')", name="tool_issue_reason"),
        sa.CheckConstraint("status IN ('open')", name="tool_issue_status"),
        sa.ForeignKeyConstraint(["tool_id"], ["tool_material_items.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["reporter_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["reporter_employee_id"], ["persons.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["recipient_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("request_id", name="uq_tool_issue_reports_request_id"),
    )
    op.create_index("ix_tool_issue_reports_tool_id", "tool_issue_reports", ["tool_id"])
    op.create_index("ix_tool_issue_reports_status", "tool_issue_reports", ["status"])
    op.create_index("ix_tool_issue_reports_reporter_user_id", "tool_issue_reports", ["reporter_user_id"])
    op.create_index("ix_tool_issue_reports_reporter_employee_id", "tool_issue_reports", ["reporter_employee_id"])
    op.create_index("ix_tool_issue_reports_recipient_user_id", "tool_issue_reports", ["recipient_user_id"])
    op.create_index("ix_tool_issue_reports_tool_status", "tool_issue_reports", ["tool_id", "status"])
    op.create_index("ix_tool_issue_reports_recipient_status", "tool_issue_reports", ["recipient_user_id", "status"])
    op.create_index("ix_tool_issue_reports_created_at", "tool_issue_reports", ["created_at"])


def downgrade() -> None:
    connection = op.get_bind()
    if "tool_issue_reports" in set(sa.inspect(connection).get_table_names()):
        op.drop_table("tool_issue_reports")
