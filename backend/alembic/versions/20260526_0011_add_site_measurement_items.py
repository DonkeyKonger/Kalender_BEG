"""Add site measurement items.

Revision ID: 20260526_0011
Revises: 20260526_0010
Create Date: 2026-05-26
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260526_0011"
down_revision: str | None = "20260526_0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "site_measurement_items",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("site_id", sa.Integer(), nullable=False),
        sa.Column("source_file_name", sa.String(length=255), nullable=True),
        sa.Column("source_project_number", sa.String(length=120), nullable=True),
        sa.Column("source_invoice_number", sa.String(length=120), nullable=True),
        sa.Column("source_customer_name", sa.String(length=255), nullable=True),
        sa.Column("position", sa.String(length=80), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("list_quantity", sa.Numeric(14, 2), nullable=True),
        sa.Column("unit", sa.String(length=40), nullable=True),
        sa.Column("minutes_per_unit", sa.Numeric(14, 2), nullable=True),
        sa.Column("list_minutes_total", sa.Numeric(14, 2), nullable=True),
        sa.Column("is_nep", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["site_id"], ["sites.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_site_measurement_items_site_id", "site_measurement_items", ["site_id"]
    )
    op.create_index(
        "ix_site_measurement_items_source_invoice_number",
        "site_measurement_items",
        ["source_invoice_number"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_site_measurement_items_source_invoice_number", table_name="site_measurement_items"
    )
    op.drop_index("ix_site_measurement_items_site_id", table_name="site_measurement_items")
    op.drop_table("site_measurement_items")
