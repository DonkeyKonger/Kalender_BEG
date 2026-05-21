"""Add person start location fields.

Revision ID: 20260521_0006
Revises: 20260521_0005
Create Date: 2026-05-21
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260521_0006"
down_revision: str | None = "20260521_0005"
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
    op.add_column("persons", sa.Column("address_postal_code", sa.String(length=20), nullable=True))
    op.add_column("persons", sa.Column("address_city", sa.String(length=120), nullable=True))
    op.add_column("persons", sa.Column("address_street", sa.String(length=200), nullable=True))
    op.add_column("persons", sa.Column("address_house_number", sa.String(length=40), nullable=True))
    op.add_column("persons", sa.Column("address_extra", sa.String(length=200), nullable=True))
    op.add_column("persons", sa.Column("address_formatted", sa.String(length=500), nullable=True))
    op.add_column("persons", sa.Column("address_latitude", sa.Float(), nullable=True))
    op.add_column("persons", sa.Column("address_longitude", sa.Float(), nullable=True))
    op.add_column(
        "persons",
        sa.Column(
            "address_location_status",
            site_location_status,
            server_default="unchecked",
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("persons", "address_location_status")
    op.drop_column("persons", "address_longitude")
    op.drop_column("persons", "address_latitude")
    op.drop_column("persons", "address_formatted")
    op.drop_column("persons", "address_extra")
    op.drop_column("persons", "address_house_number")
    op.drop_column("persons", "address_street")
    op.drop_column("persons", "address_city")
    op.drop_column("persons", "address_postal_code")
