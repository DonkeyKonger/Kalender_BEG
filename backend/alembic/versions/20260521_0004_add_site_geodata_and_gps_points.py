"""Add site geodata and GPS point foundation.

Revision ID: 20260521_0004
Revises: 20260520_0003
Create Date: 2026-05-21
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260521_0004"
down_revision: str | None = "20260520_0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

site_location_status = postgresql.ENUM(
    "unknown",
    "geocoded",
    "manually_set",
    "verified",
    name="site_location_status",
    create_type=False,
)
gps_source_type = postgresql.ENUM("vehicle", "phone", name="gps_source_type", create_type=False)


def upgrade() -> None:
    site_location_status.create(op.get_bind(), checkfirst=True)
    gps_source_type.create(op.get_bind(), checkfirst=True)

    op.add_column("sites", sa.Column("postal_code", sa.String(length=20), nullable=True))
    op.add_column("sites", sa.Column("city", sa.String(length=120), nullable=True))
    op.add_column("sites", sa.Column("latitude", sa.Float(), nullable=True))
    op.add_column("sites", sa.Column("longitude", sa.Float(), nullable=True))
    op.add_column(
        "sites",
        sa.Column("geofence_radius_m", sa.Integer(), server_default="5000", nullable=False),
    )
    op.add_column(
        "sites",
        sa.Column(
            "location_status",
            site_location_status,
            server_default="unknown",
            nullable=False,
        ),
    )

    op.add_column("persons", sa.Column("company_phone_device_id", sa.String(length=120), nullable=True))
    op.add_column("vehicles", sa.Column("gps_device_id", sa.String(length=120), nullable=True))

    op.create_table(
        "gps_points",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("source_type", gps_source_type, nullable=False),
        sa.Column("source_id", sa.String(length=120), nullable=False),
        sa.Column("person_id", sa.Integer(), nullable=True),
        sa.Column("vehicle_id", sa.Integer(), nullable=True),
        sa.Column("latitude", sa.Float(), nullable=False),
        sa.Column("longitude", sa.Float(), nullable=False),
        sa.Column("timestamp", sa.DateTime(timezone=True), nullable=False),
        sa.Column("accuracy_m", sa.Float(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["person_id"], ["persons.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["vehicle_id"], ["vehicles.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_gps_points_timestamp", "gps_points", ["timestamp"])
    op.create_index(
        "ix_gps_points_source_timestamp",
        "gps_points",
        ["source_type", "source_id", "timestamp"],
    )
    op.create_index("ix_gps_points_person_timestamp", "gps_points", ["person_id", "timestamp"])
    op.create_index("ix_gps_points_vehicle_timestamp", "gps_points", ["vehicle_id", "timestamp"])


def downgrade() -> None:
    op.drop_index("ix_gps_points_vehicle_timestamp", table_name="gps_points")
    op.drop_index("ix_gps_points_person_timestamp", table_name="gps_points")
    op.drop_index("ix_gps_points_source_timestamp", table_name="gps_points")
    op.drop_index("ix_gps_points_timestamp", table_name="gps_points")
    op.drop_table("gps_points")

    op.drop_column("vehicles", "gps_device_id")
    op.drop_column("persons", "company_phone_device_id")

    op.drop_column("sites", "location_status")
    op.drop_column("sites", "geofence_radius_m")
    op.drop_column("sites", "longitude")
    op.drop_column("sites", "latitude")
    op.drop_column("sites", "city")
    op.drop_column("sites", "postal_code")

    gps_source_type.drop(op.get_bind(), checkfirst=True)
    site_location_status.drop(op.get_bind(), checkfirst=True)
