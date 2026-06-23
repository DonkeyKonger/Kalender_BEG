"""Add original work date for payroll date corrections.

Revision ID: 20260623_0049
Revises: 20260622_0048
Create Date: 2026-06-23
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260623_0049"
down_revision: str | None = "20260622_0048"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("work_time_entries", sa.Column("original_work_date", sa.Date(), nullable=True))


def downgrade() -> None:
    op.drop_column("work_time_entries", "original_work_date")
