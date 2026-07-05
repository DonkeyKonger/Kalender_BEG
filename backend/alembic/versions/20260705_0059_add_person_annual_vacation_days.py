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


def upgrade() -> None:
    op.add_column("persons", sa.Column("annual_vacation_days", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("persons", "annual_vacation_days")
