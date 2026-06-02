"""Add time review fields to work time entries.

Revision ID: 20260602_0020
Revises: 20260601_0019
Create Date: 2026-06-02 11:30:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260602_0020"
down_revision: str | None = "20260601_0019"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("work_time_entries", sa.Column("original_work_minutes", sa.Integer(), nullable=True))
    op.add_column("work_time_entries", sa.Column("corrected_work_minutes", sa.Integer(), nullable=True))
    op.add_column(
        "work_time_entries",
        sa.Column("time_review_status", sa.String(length=40), server_default="open", nullable=False),
    )
    op.add_column("work_time_entries", sa.Column("time_review_method", sa.String(length=40), nullable=True))
    op.create_index("ix_work_time_entries_time_review_status", "work_time_entries", ["time_review_status"])


def downgrade() -> None:
    op.drop_index("ix_work_time_entries_time_review_status", table_name="work_time_entries")
    op.drop_column("work_time_entries", "time_review_method")
    op.drop_column("work_time_entries", "time_review_status")
    op.drop_column("work_time_entries", "corrected_work_minutes")
    op.drop_column("work_time_entries", "original_work_minutes")
