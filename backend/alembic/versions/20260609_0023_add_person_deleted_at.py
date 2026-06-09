"""Add person soft delete marker.

Revision ID: 20260609_0023
Revises: 20260608_0022
Create Date: 2026-06-09 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260609_0023"
down_revision: str | None = "20260608_0022"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("persons", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index("ix_persons_deleted_at", "persons", ["deleted_at"])


def downgrade() -> None:
    op.drop_index("ix_persons_deleted_at", table_name="persons")
    op.drop_column("persons", "deleted_at")
