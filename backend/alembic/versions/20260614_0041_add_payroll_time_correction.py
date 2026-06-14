"""Add payroll time correction fields.

Revision ID: 20260614_0041
Revises: 20260614_0040
Create Date: 2026-06-14
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260614_0041"
down_revision: str | None = "20260614_0040"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("work_time_entries", sa.Column("payroll_corrected_start_time", sa.Time(), nullable=True))
    op.add_column("work_time_entries", sa.Column("payroll_corrected_end_time", sa.Time(), nullable=True))
    op.add_column("work_time_entries", sa.Column("payroll_corrected_work_minutes", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("work_time_entries", "payroll_corrected_work_minutes")
    op.drop_column("work_time_entries", "payroll_corrected_end_time")
    op.drop_column("work_time_entries", "payroll_corrected_start_time")
