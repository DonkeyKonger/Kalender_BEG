"""Persist person weekly hours.

Revision ID: 20260706_0062
Revises: 20260705_0061
Create Date: 2026-07-06
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260706_0062"
down_revision: str | None = "20260705_0061"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    connection = op.get_bind()
    columns = {column["name"] for column in sa.inspect(connection).get_columns("persons")}
    if "weekly_hours" not in columns:
        op.add_column("persons", sa.Column("weekly_hours", sa.Float(), nullable=True))


def downgrade() -> None:
    connection = op.get_bind()
    columns = {column["name"] for column in sa.inspect(connection).get_columns("persons")}
    if "weekly_hours" in columns:
        op.drop_column("persons", "weekly_hours")
