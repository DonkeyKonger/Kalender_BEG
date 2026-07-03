"""Add site project value.

Revision ID: 20260703_0053
Revises: 20260629_0052
Create Date: 2026-07-03
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260703_0053"
down_revision: str | None = "20260629_0052"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("sites", sa.Column("project_value", sa.Numeric(14, 2), nullable=True))


def downgrade() -> None:
    op.drop_column("sites", "project_value")
