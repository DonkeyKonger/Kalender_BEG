"""Add extra work ticket entries.

Revision ID: 20260611_0032
Revises: 20260611_0031
Create Date: 2026-06-11 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260611_0032"
down_revision: str | None = "20260611_0031"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "extra_work_ticket_entries",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("ticket_id", sa.Integer(), nullable=False),
        sa.Column("site_id", sa.Integer(), nullable=False),
        sa.Column("component", sa.String(length=160), nullable=False),
        sa.Column("floor", sa.String(length=120), nullable=False),
        sa.Column("room_number", sa.String(length=80), nullable=True),
        sa.Column("axis", sa.String(length=80), nullable=True),
        sa.Column("remarks", sa.Text(), nullable=True),
        sa.Column("material_text", sa.Text(), nullable=True),
        sa.Column("estimated_hours", sa.Numeric(10, 2), nullable=True),
        sa.Column("worker_rows", sa.JSON(), nullable=False),
        sa.Column("created_by_user_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["site_id"], ["sites.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["ticket_id"], ["extra_work_tickets.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_extra_work_ticket_entries_created_by_user_id", "extra_work_ticket_entries", ["created_by_user_id"])
    op.create_index("ix_extra_work_ticket_entries_site_id", "extra_work_ticket_entries", ["site_id"])
    op.create_index("ix_extra_work_ticket_entries_ticket_id", "extra_work_ticket_entries", ["ticket_id"])


def downgrade() -> None:
    op.drop_index("ix_extra_work_ticket_entries_ticket_id", table_name="extra_work_ticket_entries")
    op.drop_index("ix_extra_work_ticket_entries_site_id", table_name="extra_work_ticket_entries")
    op.drop_index("ix_extra_work_ticket_entries_created_by_user_id", table_name="extra_work_ticket_entries")
    op.drop_table("extra_work_ticket_entries")
