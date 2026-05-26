"""Add submitted measurement entry snapshot.

Revision ID: 20260526_0014
Revises: 20260526_0013
Create Date: 2026-05-26
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260526_0014"
down_revision: str | Sequence[str] | None = "20260526_0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "site_measurement_entries",
        sa.Column("submitted_quantity", sa.Numeric(14, 2), nullable=True),
    )
    op.add_column(
        "site_measurement_entries",
        sa.Column("submitted_area_or_comment", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("site_measurement_entries", "submitted_area_or_comment")
    op.drop_column("site_measurement_entries", "submitted_quantity")
