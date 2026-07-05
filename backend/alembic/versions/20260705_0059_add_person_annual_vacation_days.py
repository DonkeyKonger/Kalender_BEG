"""Add person annual vacation days.

Revision ID: 20260705_0059
Revises: 20260705_0058
Create Date: 2026-07-05
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260705_0059"
down_revision: str | None = "20260705_0058"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _column_exists(table_name: str, column_name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return any(column["name"] == column_name for column in inspector.get_columns(table_name))


def upgrade() -> None:
    if not _column_exists("persons", "annual_vacation_days"):
        op.add_column("persons", sa.Column("annual_vacation_days", sa.Integer(), nullable=True))


def downgrade() -> None:
    if _column_exists("persons", "annual_vacation_days"):
        op.drop_column("persons", "annual_vacation_days")
