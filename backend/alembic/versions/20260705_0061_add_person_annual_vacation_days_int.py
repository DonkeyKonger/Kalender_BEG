"""Persist person annual vacation days.

Revision ID: 20260705_0061
Revises: 20260705_0060
Create Date: 2026-07-05
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260705_0061"
down_revision: str | None = "20260705_0060"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    connection = op.get_bind()
    columns = {column["name"] for column in sa.inspect(connection).get_columns("persons")}
    if "annual_vacation_days" not in columns:
        op.add_column("persons", sa.Column("annual_vacation_days", sa.Integer(), nullable=True))


def downgrade() -> None:
    connection = op.get_bind()
    columns = {column["name"] for column in sa.inspect(connection).get_columns("persons")}
    if "annual_vacation_days" in columns:
        op.drop_column("persons", "annual_vacation_days")
