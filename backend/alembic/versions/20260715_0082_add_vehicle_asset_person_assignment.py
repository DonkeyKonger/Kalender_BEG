"""Add a stable employee assignment to Ctrack vehicle assets.

Revision ID: 20260715_0082
Revises: 20260715_0081
Create Date: 2026-07-15
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260715_0082"
down_revision: str | None = "20260715_0081"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if "vehicle_assets" not in inspector.get_table_names():
        return
    columns = {column["name"] for column in inspector.get_columns("vehicle_assets")}
    if "assigned_person_id" in columns:
        return
    with op.batch_alter_table("vehicle_assets") as batch_op:
        batch_op.add_column(sa.Column("assigned_person_id", sa.Integer(), nullable=True))
        batch_op.create_foreign_key(
            "fk_vehicle_assets_assigned_person_id_persons",
            "persons",
            ["assigned_person_id"],
            ["id"],
            ondelete="SET NULL",
        )
        batch_op.create_index(
            "ix_vehicle_assets_assigned_person_id",
            ["assigned_person_id"],
            unique=True,
        )


def downgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if "vehicle_assets" not in inspector.get_table_names():
        return
    columns = {column["name"] for column in inspector.get_columns("vehicle_assets")}
    if "assigned_person_id" not in columns:
        return
    with op.batch_alter_table("vehicle_assets") as batch_op:
        batch_op.drop_index("ix_vehicle_assets_assigned_person_id")
        batch_op.drop_constraint(
            "fk_vehicle_assets_assigned_person_id_persons",
            type_="foreignkey",
        )
        batch_op.drop_column("assigned_person_id")
