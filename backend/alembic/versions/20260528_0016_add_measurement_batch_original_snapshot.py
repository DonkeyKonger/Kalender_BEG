"""Add measurement batch original submitted snapshot.

Revision ID: 20260528_0016
Revises: 20260527_0015
Create Date: 2026-05-28
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260528_0016"
down_revision: str | Sequence[str] | None = "20260527_0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "site_measurement_batches",
        sa.Column("original_submitted_snapshot", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("site_measurement_batches", "original_submitted_snapshot")
