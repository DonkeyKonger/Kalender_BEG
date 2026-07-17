"""Link blank measurement positions to calculated project positions.

Revision ID: 20260717_0088
Revises: 20260716_0087
Create Date: 2026-07-17
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260717_0088"
down_revision: str | None = "20260716_0087"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "site_measurement_items",
        sa.Column("linked_measurement_item_id", sa.Integer(), nullable=True),
    )
    op.create_index(
        "ix_site_measurement_items_linked_measurement_item_id",
        "site_measurement_items",
        ["linked_measurement_item_id"],
        unique=False,
    )
    op.create_foreign_key(
        "fk_site_measurement_items_linked_measurement_item_id",
        "site_measurement_items",
        "site_measurement_items",
        ["linked_measurement_item_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_site_measurement_items_linked_measurement_item_id",
        "site_measurement_items",
        type_="foreignkey",
    )
    op.drop_index(
        "ix_site_measurement_items_linked_measurement_item_id",
        table_name="site_measurement_items",
    )
    op.drop_column("site_measurement_items", "linked_measurement_item_id")
