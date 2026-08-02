"""Add payroll-corrected break minutes.

Revision ID: 20260802_0093
Revises: 20260717_0092
Create Date: 2026-08-02
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260802_0093"
down_revision: str | None = "20260717_0092"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if "work_time_entries" not in inspector.get_table_names():
        return
    columns = {column["name"] for column in inspector.get_columns("work_time_entries")}
    if "payroll_corrected_break_minutes" not in columns:
        op.add_column(
            "work_time_entries",
            sa.Column("payroll_corrected_break_minutes", sa.Integer(), nullable=True),
        )


def downgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if "work_time_entries" not in inspector.get_table_names():
        return
    columns = {column["name"] for column in inspector.get_columns("work_time_entries")}
    if "payroll_corrected_break_minutes" in columns:
        op.drop_column("work_time_entries", "payroll_corrected_break_minutes")
