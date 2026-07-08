"""Add weekly detail fields to hours account entries.

Revision ID: 20260708_0067
Revises: 20260708_0066
Create Date: 2026-07-08
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260708_0067"
down_revision: str | None = "20260708_0066"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


DETAIL_COLUMNS = {
    "weekly_work_minutes": sa.Column("weekly_work_minutes", sa.Integer(), nullable=True),
    "weekly_overtime_absence_minutes": sa.Column("weekly_overtime_absence_minutes", sa.Integer(), nullable=True),
    "weekly_absence_breakdown": sa.Column("weekly_absence_breakdown", sa.JSON(), nullable=True),
}


def upgrade() -> None:
    connection = op.get_bind()
    tables = set(sa.inspect(connection).get_table_names())
    if "person_hours_account_entries" not in tables:
        return
    columns = {
        column["name"]
        for column in sa.inspect(connection).get_columns("person_hours_account_entries")
    }
    for column_name, column in DETAIL_COLUMNS.items():
        if column_name not in columns:
            op.add_column("person_hours_account_entries", column)


def downgrade() -> None:
    connection = op.get_bind()
    tables = set(sa.inspect(connection).get_table_names())
    if "person_hours_account_entries" not in tables:
        return
    columns = {
        column["name"]
        for column in sa.inspect(connection).get_columns("person_hours_account_entries")
    }
    for column_name in reversed(DETAIL_COLUMNS):
        if column_name in columns:
            op.drop_column("person_hours_account_entries", column_name)
