"""Refine site address geocoding fields.

Revision ID: 20260521_0005
Revises: 20260521_0004
Create Date: 2026-05-21
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260521_0005"
down_revision: str | None = "20260521_0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE site_location_status ADD VALUE IF NOT EXISTS 'unchecked'")
        op.execute("ALTER TYPE site_location_status ADD VALUE IF NOT EXISTS 'ambiguous'")
        op.execute("ALTER TYPE site_location_status ADD VALUE IF NOT EXISTS 'failed'")

    op.add_column("sites", sa.Column("street", sa.String(length=200), nullable=True))
    op.add_column("sites", sa.Column("house_number", sa.String(length=40), nullable=True))
    op.add_column("sites", sa.Column("address_extra", sa.String(length=200), nullable=True))
    op.alter_column("sites", "location_status", server_default="unchecked")
    op.execute("UPDATE sites SET location_status = 'unchecked' WHERE location_status = 'unknown'")
    op.execute("UPDATE sites SET location_status = 'geocoded' WHERE location_status IN ('manually_set', 'verified')")


def downgrade() -> None:
    op.alter_column("sites", "location_status", server_default="unknown")
    op.execute("UPDATE sites SET location_status = 'unknown' WHERE location_status IN ('unchecked', 'ambiguous', 'failed')")
    op.drop_column("sites", "address_extra")
    op.drop_column("sites", "house_number")
    op.drop_column("sites", "street")
