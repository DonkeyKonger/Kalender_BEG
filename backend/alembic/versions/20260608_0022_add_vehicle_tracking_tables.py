"""Add vehicle tracking tables.

Revision ID: 20260608_0022
Revises: 20260603_0021
Create Date: 2026-06-08 13:30:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260608_0022"
down_revision: str | None = "20260603_0021"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "vehicle_assets",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("source", sa.String(length=40), nullable=False, server_default="ctrack"),
        sa.Column("external_id", sa.String(length=120), nullable=False),
        sa.Column("ctrack_node_id", sa.Integer(), nullable=True),
        sa.Column("label", sa.String(length=160), nullable=True),
        sa.Column("vehicle_registration", sa.String(length=80), nullable=True),
        sa.Column("fleet_number", sa.String(length=80), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("raw_payload", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("source", "external_id", name="uq_vehicle_assets_source_external_id"),
    )
    op.create_index("ix_vehicle_assets_source", "vehicle_assets", ["source"])

    op.create_table(
        "vehicle_position_logs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("vehicle_asset_id", sa.Integer(), nullable=False),
        sa.Column("source", sa.String(length=40), nullable=False, server_default="ctrack"),
        sa.Column("external_id", sa.String(length=160), nullable=True),
        sa.Column("event_time_utc", sa.DateTime(timezone=True), nullable=False),
        sa.Column("received_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("latitude", sa.Float(), nullable=False),
        sa.Column("longitude", sa.Float(), nullable=False),
        sa.Column("speed", sa.Float(), nullable=True),
        sa.Column("ignition", sa.Boolean(), nullable=True),
        sa.Column("odometer", sa.Float(), nullable=True),
        sa.Column("heading_text", sa.String(length=120), nullable=True),
        sa.Column("driver_id", sa.String(length=120), nullable=True),
        sa.Column("driver_name", sa.String(length=160), nullable=True),
        sa.Column("location_text", sa.Text(), nullable=True),
        sa.Column("raw_payload", sa.JSON(), nullable=True),
        sa.ForeignKeyConstraint(["vehicle_asset_id"], ["vehicle_assets.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "vehicle_asset_id",
            "event_time_utc",
            "source",
            name="uq_vehicle_position_logs_asset_time_source",
        ),
    )
    op.create_index(
        "ix_vehicle_position_logs_event_time_utc",
        "vehicle_position_logs",
        ["event_time_utc"],
    )
    op.create_index("ix_vehicle_position_logs_source", "vehicle_position_logs", ["source"])
    op.create_index(
        "ix_vehicle_position_logs_vehicle_asset_id",
        "vehicle_position_logs",
        ["vehicle_asset_id"],
    )

    op.create_table(
        "vehicle_latest_positions",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("vehicle_asset_id", sa.Integer(), nullable=False),
        sa.Column("event_time_utc", sa.DateTime(timezone=True), nullable=False),
        sa.Column("latitude", sa.Float(), nullable=False),
        sa.Column("longitude", sa.Float(), nullable=False),
        sa.Column("speed", sa.Float(), nullable=True),
        sa.Column("ignition", sa.Boolean(), nullable=True),
        sa.Column("odometer", sa.Float(), nullable=True),
        sa.Column("driver_id", sa.String(length=120), nullable=True),
        sa.Column("driver_name", sa.String(length=160), nullable=True),
        sa.Column("location_text", sa.Text(), nullable=True),
        sa.Column("source", sa.String(length=40), nullable=False, server_default="ctrack"),
        sa.Column("raw_payload", sa.JSON(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["vehicle_asset_id"], ["vehicle_assets.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("vehicle_asset_id"),
    )
    op.create_index(
        "ix_vehicle_latest_positions_event_time_utc",
        "vehicle_latest_positions",
        ["event_time_utc"],
    )
    op.create_index("ix_vehicle_latest_positions_source", "vehicle_latest_positions", ["source"])
    op.create_index(
        "ix_vehicle_latest_positions_vehicle_asset_id",
        "vehicle_latest_positions",
        ["vehicle_asset_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_vehicle_latest_positions_vehicle_asset_id", table_name="vehicle_latest_positions")
    op.drop_index("ix_vehicle_latest_positions_source", table_name="vehicle_latest_positions")
    op.drop_index("ix_vehicle_latest_positions_event_time_utc", table_name="vehicle_latest_positions")
    op.drop_table("vehicle_latest_positions")
    op.drop_index("ix_vehicle_position_logs_vehicle_asset_id", table_name="vehicle_position_logs")
    op.drop_index("ix_vehicle_position_logs_source", table_name="vehicle_position_logs")
    op.drop_index("ix_vehicle_position_logs_event_time_utc", table_name="vehicle_position_logs")
    op.drop_table("vehicle_position_logs")
    op.drop_index("ix_vehicle_assets_source", table_name="vehicle_assets")
    op.drop_table("vehicle_assets")
