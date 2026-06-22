"""Add measurement item batch link.

Revision ID: 20260622_0048
Revises: 20260622_0047
Create Date: 2026-06-22
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260622_0048"
down_revision: str | None = "20260622_0047"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("site_measurement_items", sa.Column("measurement_batch_id", sa.Integer(), nullable=True))
    op.create_index(
        "ix_site_measurement_items_measurement_batch_id",
        "site_measurement_items",
        ["measurement_batch_id"],
    )
    op.create_foreign_key(
        "fk_site_measurement_items_measurement_batch_id",
        "site_measurement_items",
        "site_measurement_batches",
        ["measurement_batch_id"],
        ["id"],
        ondelete="CASCADE",
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_site_measurement_items_measurement_batch_id",
        "site_measurement_items",
        type_="foreignkey",
    )
    op.drop_index("ix_site_measurement_items_measurement_batch_id", table_name="site_measurement_items")
    op.drop_column("site_measurement_items", "measurement_batch_id")
