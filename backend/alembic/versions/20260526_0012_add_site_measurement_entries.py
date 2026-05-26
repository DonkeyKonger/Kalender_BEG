"""Add site measurement entries.

Revision ID: 20260526_0012
Revises: 20260526_0011
Create Date: 2026-05-26
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260526_0012"
down_revision: str | None = "20260526_0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "site_measurement_entries",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("measurement_item_id", sa.Integer(), nullable=False),
        sa.Column("site_id", sa.Integer(), nullable=False),
        sa.Column("quantity", sa.Numeric(14, 2), nullable=False),
        sa.Column("area_or_comment", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=40), nullable=False, server_default="saved"),
        sa.Column("created_by_user_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["measurement_item_id"], ["site_measurement_items.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["site_id"], ["sites.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_site_measurement_entries_measurement_item_id",
        "site_measurement_entries",
        ["measurement_item_id"],
    )
    op.create_index("ix_site_measurement_entries_site_id", "site_measurement_entries", ["site_id"])
    op.create_index(
        "ix_site_measurement_entries_created_by_user_id",
        "site_measurement_entries",
        ["created_by_user_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_site_measurement_entries_created_by_user_id", table_name="site_measurement_entries")
    op.drop_index("ix_site_measurement_entries_site_id", table_name="site_measurement_entries")
    op.drop_index(
        "ix_site_measurement_entries_measurement_item_id",
        table_name="site_measurement_entries",
    )
    op.drop_table("site_measurement_entries")
