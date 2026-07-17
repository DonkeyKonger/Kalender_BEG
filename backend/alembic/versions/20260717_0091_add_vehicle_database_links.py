"""Extend internal vehicles with assignment and C-Track links.

Revision ID: 20260717_0091
Revises: 20260717_0090
Create Date: 2026-07-17
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260717_0091"
down_revision: str | None = "20260717_0090"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if "vehicles" not in inspector.get_table_names():
        return
    columns = {column["name"] for column in inspector.get_columns("vehicles")}
    with op.batch_alter_table("vehicles") as batch_op:
        if "manufacturer" not in columns:
            batch_op.add_column(sa.Column("manufacturer", sa.String(length=120), nullable=True))
        if "assigned_person_id" not in columns:
            batch_op.add_column(sa.Column("assigned_person_id", sa.Integer(), nullable=True))
            batch_op.create_foreign_key(
                "fk_vehicles_assigned_person_id_persons",
                "persons",
                ["assigned_person_id"],
                ["id"],
                ondelete="SET NULL",
            )
        if "ctrack_vehicle_asset_id" not in columns:
            batch_op.add_column(sa.Column("ctrack_vehicle_asset_id", sa.Integer(), nullable=True))
            batch_op.create_foreign_key(
                "fk_vehicles_ctrack_vehicle_asset_id_vehicle_assets",
                "vehicle_assets",
                ["ctrack_vehicle_asset_id"],
                ["id"],
                ondelete="SET NULL",
            )

    op.execute(sa.text("UPDATE vehicles SET manufacturer = name WHERE manufacturer IS NULL"))
    with op.batch_alter_table("vehicles") as batch_op:
        batch_op.alter_column("manufacturer", existing_type=sa.String(length=120), nullable=False)

    inspector = sa.inspect(connection)
    indexes = {index["name"] for index in inspector.get_indexes("vehicles")}
    if "ix_vehicles_assigned_person_id" not in indexes:
        op.create_index("ix_vehicles_assigned_person_id", "vehicles", ["assigned_person_id"])
    if "ix_vehicles_ctrack_vehicle_asset_id" not in indexes:
        op.create_index(
            "ix_vehicles_ctrack_vehicle_asset_id",
            "vehicles",
            ["ctrack_vehicle_asset_id"],
            unique=True,
        )
    if "ux_vehicles_license_plate_lower" not in indexes:
        op.create_index(
            "ux_vehicles_license_plate_lower",
            "vehicles",
            [sa.text("lower(license_plate)")],
            unique=True,
        )


def downgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if "vehicles" not in inspector.get_table_names():
        return
    indexes = {index["name"] for index in inspector.get_indexes("vehicles")}
    for name in (
        "ux_vehicles_license_plate_lower",
        "ix_vehicles_ctrack_vehicle_asset_id",
        "ix_vehicles_assigned_person_id",
    ):
        if name in indexes:
            op.drop_index(name, table_name="vehicles")
    columns = {column["name"] for column in inspector.get_columns("vehicles")}
    with op.batch_alter_table("vehicles") as batch_op:
        if "ctrack_vehicle_asset_id" in columns:
            batch_op.drop_constraint(
                "fk_vehicles_ctrack_vehicle_asset_id_vehicle_assets", type_="foreignkey"
            )
            batch_op.drop_column("ctrack_vehicle_asset_id")
        if "assigned_person_id" in columns:
            batch_op.drop_constraint("fk_vehicles_assigned_person_id_persons", type_="foreignkey")
            batch_op.drop_column("assigned_person_id")
        if "manufacturer" in columns:
            batch_op.drop_column("manufacturer")
