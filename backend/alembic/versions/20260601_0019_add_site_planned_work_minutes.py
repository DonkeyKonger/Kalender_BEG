"""Add planned work minutes to sites.

Revision ID: 20260601_0019
Revises: 20260601_0018
Create Date: 2026-06-01 15:20:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260601_0019"
down_revision: str | None = "20260601_0018"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("sites", sa.Column("planned_work_minutes", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("sites", "planned_work_minutes")
