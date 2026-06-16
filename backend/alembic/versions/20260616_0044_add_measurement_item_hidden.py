"""Add hidden flag to measurement items.

Revision ID: 20260616_0044
Revises: 20260615_0043
Create Date: 2026-06-16
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260616_0044"
down_revision: str | None = "20260615_0043"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "site_measurement_items",
        sa.Column("is_hidden", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_index(
        "ix_site_measurement_items_is_hidden",
        "site_measurement_items",
        ["is_hidden"],
    )
    op.alter_column("site_measurement_items", "is_hidden", server_default=None)


def downgrade() -> None:
    op.drop_index("ix_site_measurement_items_is_hidden", table_name="site_measurement_items")
    op.drop_column("site_measurement_items", "is_hidden")
