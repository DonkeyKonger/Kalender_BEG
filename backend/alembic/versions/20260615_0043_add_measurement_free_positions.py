"""Add free position flag to measurement items.

Revision ID: 20260615_0043
Revises: 20260615_0042
Create Date: 2026-06-15
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260615_0043"
down_revision: str | None = "20260615_0042"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "site_measurement_items",
        sa.Column("is_free_position", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.alter_column("site_measurement_items", "is_free_position", server_default=None)


def downgrade() -> None:
    op.drop_column("site_measurement_items", "is_free_position")
