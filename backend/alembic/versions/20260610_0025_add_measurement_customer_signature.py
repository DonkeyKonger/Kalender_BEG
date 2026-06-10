"""Add customer signature fields to measurement batches.

Revision ID: 20260610_0025
Revises: 20260609_0024
Create Date: 2026-06-10 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260610_0025"
down_revision: str | None = "20260609_0024"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "site_measurement_batches",
        sa.Column("customer_signed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "site_measurement_batches",
        sa.Column("customer_signature_name", sa.String(length=160), nullable=True),
    )
    op.add_column(
        "site_measurement_batches",
        sa.Column("customer_signature_strokes", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("site_measurement_batches", "customer_signature_strokes")
    op.drop_column("site_measurement_batches", "customer_signature_name")
    op.drop_column("site_measurement_batches", "customer_signed_at")
