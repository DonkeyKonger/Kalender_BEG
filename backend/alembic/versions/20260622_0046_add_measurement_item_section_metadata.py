"""Add section metadata to measurement items.

Revision ID: 20260622_0046
Revises: 20260618_0045
Create Date: 2026-06-22
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260622_0046"
down_revision: str | None = "20260618_0045"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "site_measurement_items",
        sa.Column("source_section_key", sa.String(length=80), nullable=True),
    )
    op.add_column(
        "site_measurement_items",
        sa.Column("source_section_title", sa.String(length=255), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("site_measurement_items", "source_section_title")
    op.drop_column("site_measurement_items", "source_section_key")
