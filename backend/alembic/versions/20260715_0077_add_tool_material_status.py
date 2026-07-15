"""Add status to tool material items.

Revision ID: 20260715_0077
Revises: 20260715_0076
Create Date: 2026-07-15
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260715_0077"
down_revision: str | None = "20260715_0076"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

STATUS_VALUES = ("issued", "warehouse", "defective")


def upgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if "tool_material_items" not in inspector.get_table_names():
        return

    columns = {column["name"] for column in inspector.get_columns("tool_material_items")}
    if "status" not in columns:
        op.add_column(
            "tool_material_items",
            sa.Column(
                "status",
                sa.String(length=20),
                nullable=False,
                server_default="warehouse",
            ),
        )
        connection.execute(
            sa.text(
                "UPDATE tool_material_items "
                "SET status = 'issued' "
                "WHERE employee_id IS NOT NULL"
            )
        )

    check_constraints = {
        constraint["name"]
        for constraint in sa.inspect(connection).get_check_constraints("tool_material_items")
    }
    if "ck_tool_material_items_status" not in check_constraints:
        with op.batch_alter_table("tool_material_items") as batch_op:
            batch_op.create_check_constraint(
                "ck_tool_material_items_status",
                "status IN ('issued', 'warehouse', 'defective')",
            )

    indexes = {index["name"] for index in sa.inspect(connection).get_indexes("tool_material_items")}
    if "ix_tool_material_items_status" not in indexes:
        op.create_index(
            "ix_tool_material_items_status",
            "tool_material_items",
            ["status"],
            unique=False,
        )


def downgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if "tool_material_items" not in inspector.get_table_names():
        return

    indexes = {index["name"] for index in inspector.get_indexes("tool_material_items")}
    if "ix_tool_material_items_status" in indexes:
        op.drop_index("ix_tool_material_items_status", table_name="tool_material_items")

    check_constraints = {
        constraint["name"]
        for constraint in sa.inspect(connection).get_check_constraints("tool_material_items")
    }
    if "ck_tool_material_items_status" in check_constraints:
        with op.batch_alter_table("tool_material_items") as batch_op:
            batch_op.drop_constraint("ck_tool_material_items_status", type_="check")

    columns = {column["name"] for column in sa.inspect(connection).get_columns("tool_material_items")}
    if "status" in columns:
        op.drop_column("tool_material_items", "status")
