"""Replace the defective tool material status with written off.

Revision ID: 20260715_0080
Revises: 20260715_0079
Create Date: 2026-07-15
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260715_0080"
down_revision: str | None = "20260715_0079"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

STATUS_CONSTRAINT_NAME = "ck_tool_material_items_status"


def upgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if "tool_material_items" not in inspector.get_table_names():
        return

    columns = {column["name"] for column in inspector.get_columns("tool_material_items")}
    if "status" not in columns:
        return

    _drop_status_constraint_if_present(connection)
    if "employee_id" in columns:
        connection.execute(
            sa.text(
                "UPDATE tool_material_items "
                "SET employee_id = NULL "
                "WHERE status = 'defective'"
            )
        )
    connection.execute(
        sa.text(
            "UPDATE tool_material_items "
            "SET status = 'written_off' "
            "WHERE status = 'defective'"
        )
    )
    _create_status_constraint(connection, "written_off")


def downgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if "tool_material_items" not in inspector.get_table_names():
        return

    columns = {column["name"] for column in inspector.get_columns("tool_material_items")}
    if "status" not in columns:
        return

    _drop_status_constraint_if_present(connection)
    connection.execute(
        sa.text(
            "UPDATE tool_material_items "
            "SET status = 'defective' "
            "WHERE status = 'written_off'"
        )
    )
    _create_status_constraint(connection, "defective")


def _drop_status_constraint_if_present(connection) -> None:
    constraints = {
        constraint["name"]
        for constraint in sa.inspect(connection).get_check_constraints("tool_material_items")
    }
    if STATUS_CONSTRAINT_NAME in constraints:
        with op.batch_alter_table("tool_material_items") as batch_op:
            batch_op.drop_constraint(STATUS_CONSTRAINT_NAME, type_="check")


def _create_status_constraint(connection, third_status: str) -> None:
    constraints = {
        constraint["name"]
        for constraint in sa.inspect(connection).get_check_constraints("tool_material_items")
    }
    if STATUS_CONSTRAINT_NAME not in constraints:
        with op.batch_alter_table("tool_material_items") as batch_op:
            batch_op.create_check_constraint(
                STATUS_CONSTRAINT_NAME,
                f"status IN ('issued', 'warehouse', '{third_status}')",
            )
