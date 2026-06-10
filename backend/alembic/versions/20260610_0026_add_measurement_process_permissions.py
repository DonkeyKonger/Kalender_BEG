"""Add measurement signature process permissions.

Revision ID: 20260610_0026
Revises: 20260610_0025
Create Date: 2026-06-10 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260610_0026"
down_revision: str | None = "20260610_0025"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "persons",
        sa.Column(
            "can_sign_measurements_immediately",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.add_column(
        "site_measurement_batches",
        sa.Column("customer_signed_snapshot", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("site_measurement_batches", "customer_signed_snapshot")
    op.drop_column("persons", "can_sign_measurements_immediately")
