"""Update site geofence default radius.

Revision ID: 20260603_0021
Revises: 20260602_0020
Create Date: 2026-06-03
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260603_0021"
down_revision: str | None = "20260602_0020"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column("sites", "geofence_radius_m", server_default=sa.text("3000"))


def downgrade() -> None:
    op.alter_column("sites", "geofence_radius_m", server_default=sa.text("5000"))
