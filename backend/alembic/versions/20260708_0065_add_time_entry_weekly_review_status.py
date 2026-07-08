"""Add time entry weekly review status.

Revision ID: 20260708_0065
Revises: 20260707_0064
Create Date: 2026-07-08
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260708_0065"
down_revision: str | None = "20260707_0064"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    connection = op.get_bind()
    tables = set(sa.inspect(connection).get_table_names())
    if "time_entry_weekly_reviews" not in tables:
        return
    columns = {
        column["name"]
        for column in sa.inspect(connection).get_columns("time_entry_weekly_reviews")
    }
    if "status" not in columns:
        op.add_column(
            "time_entry_weekly_reviews",
            sa.Column("status", sa.String(length=40), nullable=False, server_default="reviewed"),
        )


def downgrade() -> None:
    connection = op.get_bind()
    tables = set(sa.inspect(connection).get_table_names())
    if "time_entry_weekly_reviews" not in tables:
        return
    columns = {
        column["name"]
        for column in sa.inspect(connection).get_columns("time_entry_weekly_reviews")
    }
    if "status" in columns:
        op.drop_column("time_entry_weekly_reviews", "status")
