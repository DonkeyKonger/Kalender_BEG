"""Add extra work tickets.

Revision ID: 20260610_0027
Revises: 20260610_0026
Create Date: 2026-06-10 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260610_0027"
down_revision: str | None = "20260610_0026"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "extra_work_tickets",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("site_id", sa.Integer(), nullable=False),
        sa.Column("sequence_number", sa.Integer(), nullable=False),
        sa.Column("display_number", sa.String(length=120), nullable=False),
        sa.Column("title", sa.String(length=160), nullable=True),
        sa.Column("status", sa.String(length=40), nullable=False),
        sa.Column("created_by_user_id", sa.Integer(), nullable=True),
        sa.Column("submitted_by_user_id", sa.Integer(), nullable=True),
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["site_id"], ["sites.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["submitted_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("site_id", "sequence_number", name="uq_extra_work_tickets_site_sequence"),
    )
    op.create_index("ix_extra_work_tickets_created_by_user_id", "extra_work_tickets", ["created_by_user_id"])
    op.create_index("ix_extra_work_tickets_site_id", "extra_work_tickets", ["site_id"])
    op.create_index("ix_extra_work_tickets_status", "extra_work_tickets", ["status"])
    op.create_index("ix_extra_work_tickets_submitted_by_user_id", "extra_work_tickets", ["submitted_by_user_id"])


def downgrade() -> None:
    op.drop_index("ix_extra_work_tickets_submitted_by_user_id", table_name="extra_work_tickets")
    op.drop_index("ix_extra_work_tickets_status", table_name="extra_work_tickets")
    op.drop_index("ix_extra_work_tickets_site_id", table_name="extra_work_tickets")
    op.drop_index("ix_extra_work_tickets_created_by_user_id", table_name="extra_work_tickets")
    op.drop_table("extra_work_tickets")
