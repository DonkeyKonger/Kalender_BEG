"""Add customer notes.

Revision ID: 20260704_0057
Revises: 20260704_0056
Create Date: 2026-07-04
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260704_0057"
down_revision: str | None = "20260704_0056"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("customers", sa.Column("notes", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("customers", "notes")
