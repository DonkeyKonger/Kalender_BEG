"""Add customer address geodata.

Revision ID: 20260704_0054
Revises: 20260703_0053
Create Date: 2026-07-04
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision: str = "20260704_0054"
down_revision: str | None = "20260703_0053"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

site_location_status = postgresql.ENUM(
    "unchecked",
    "geocoded",
    "ambiguous",
    "failed",
    name="site_location_status",
    create_type=False,
)


def upgrade() -> None:
    op.add_column("customers", sa.Column("address_extra", sa.String(length=200), nullable=True))
    op.add_column("customers", sa.Column("address_formatted", sa.String(length=500), nullable=True))
    op.add_column("customers", sa.Column("address_latitude", sa.Float(), nullable=True))
    op.add_column("customers", sa.Column("address_longitude", sa.Float(), nullable=True))
    op.add_column(
        "customers",
        sa.Column(
            "address_location_status",
            site_location_status,
            server_default="unchecked",
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("customers", "address_location_status")
    op.drop_column("customers", "address_longitude")
    op.drop_column("customers", "address_latitude")
    op.drop_column("customers", "address_formatted")
    op.drop_column("customers", "address_extra")
