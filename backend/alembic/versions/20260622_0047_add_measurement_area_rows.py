"""Add measurement area rows.

Revision ID: 20260622_0047
Revises: 20260622_0046
Create Date: 2026-06-22
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260622_0047"
down_revision: str | None = "20260622_0046"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "site_measurement_area_rows",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("measurement_batch_id", sa.Integer(), nullable=False),
        sa.Column("site_id", sa.Integer(), nullable=False),
        sa.Column("area_or_comment", sa.Text(), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column("created_by_user_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["measurement_batch_id"], ["site_measurement_batches.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["site_id"], ["sites.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_site_measurement_area_rows_measurement_batch_id",
        "site_measurement_area_rows",
        ["measurement_batch_id"],
    )
    op.create_index("ix_site_measurement_area_rows_site_id", "site_measurement_area_rows", ["site_id"])
    op.create_index(
        "ix_site_measurement_area_rows_created_by_user_id",
        "site_measurement_area_rows",
        ["created_by_user_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_site_measurement_area_rows_created_by_user_id", table_name="site_measurement_area_rows")
    op.drop_index("ix_site_measurement_area_rows_site_id", table_name="site_measurement_area_rows")
    op.drop_index("ix_site_measurement_area_rows_measurement_batch_id", table_name="site_measurement_area_rows")
    op.drop_table("site_measurement_area_rows")
