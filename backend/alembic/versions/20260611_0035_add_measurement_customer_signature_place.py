"""add measurement customer signature place

Revision ID: 20260611_0035
Revises: 20260611_0034
Create Date: 2026-06-11
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260611_0035"
down_revision: str | None = "20260611_0034"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "site_measurement_batches",
        sa.Column("customer_signature_place", sa.String(length=260), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("site_measurement_batches", "customer_signature_place")
