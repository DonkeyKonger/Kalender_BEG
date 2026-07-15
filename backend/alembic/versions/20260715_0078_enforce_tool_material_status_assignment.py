"""Enforce tool material status and employee consistency.

Revision ID: 20260715_0078
Revises: 20260715_0077
Create Date: 2026-07-15
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260715_0078"
down_revision: str | None = "20260715_0077"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

CONSTRAINT_NAME = "ck_tool_material_items_status_employee"


def upgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if "tool_material_items" not in inspector.get_table_names():
        return

    columns = {column["name"] for column in inspector.get_columns("tool_material_items")}
    if not {"status", "employee_id"}.issubset(columns):
        return

    connection.execute(
        sa.text(
            "UPDATE tool_material_items "
            "SET employee_id = NULL "
            "WHERE status IN ('warehouse', 'defective') "
            "AND employee_id IS NOT NULL"
        )
    )
    constraints = {
        constraint["name"]
        for constraint in sa.inspect(connection).get_check_constraints("tool_material_items")
    }
    if CONSTRAINT_NAME not in constraints:
        with op.batch_alter_table("tool_material_items") as batch_op:
            batch_op.create_check_constraint(
                CONSTRAINT_NAME,
                "status = 'issued' OR employee_id IS NULL",
            )


def downgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if "tool_material_items" not in inspector.get_table_names():
        return

    constraints = {
        constraint["name"]
        for constraint in inspector.get_check_constraints("tool_material_items")
    }
    if CONSTRAINT_NAME in constraints:
        with op.batch_alter_table("tool_material_items") as batch_op:
            batch_op.drop_constraint(CONSTRAINT_NAME, type_="check")
