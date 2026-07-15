"""Add the persisted tool material category.

Revision ID: 20260715_0081
Revises: 20260715_0080
Create Date: 2026-07-15
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260715_0081"
down_revision: str | None = "20260715_0080"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

CATEGORY_VALUES = (
    "drilling_screwing",
    "grinding_cutting",
    "sawing",
    "vacuuming",
    "measuring",
    "batteries_charging",
    "hand_tools",
    "ladders_work_equipment",
    "testing_equipment",
    "vehicle_accessories",
    "material",
    "other",
)
CATEGORY_CONSTRAINT = "ck_tool_material_items_category"
CATEGORY_INDEX = "ix_tool_material_items_category"


def upgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if "tool_material_items" not in inspector.get_table_names():
        return

    columns = {column["name"] for column in inspector.get_columns("tool_material_items")}
    if "category" not in columns:
        op.add_column(
            "tool_material_items",
            sa.Column("category", sa.String(length=40), nullable=False, server_default="other"),
        )

    constraints = {
        constraint["name"]
        for constraint in sa.inspect(connection).get_check_constraints("tool_material_items")
    }
    if CATEGORY_CONSTRAINT not in constraints:
        allowed = ", ".join(f"'{value}'" for value in CATEGORY_VALUES)
        with op.batch_alter_table("tool_material_items") as batch_op:
            batch_op.create_check_constraint(CATEGORY_CONSTRAINT, f"category IN ({allowed})")

    indexes = {index["name"] for index in sa.inspect(connection).get_indexes("tool_material_items")}
    if CATEGORY_INDEX not in indexes:
        op.create_index(CATEGORY_INDEX, "tool_material_items", ["category"], unique=False)


def downgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if "tool_material_items" not in inspector.get_table_names():
        return

    indexes = {index["name"] for index in inspector.get_indexes("tool_material_items")}
    if CATEGORY_INDEX in indexes:
        op.drop_index(CATEGORY_INDEX, table_name="tool_material_items")

    constraints = {
        constraint["name"]
        for constraint in sa.inspect(connection).get_check_constraints("tool_material_items")
    }
    if CATEGORY_CONSTRAINT in constraints:
        with op.batch_alter_table("tool_material_items") as batch_op:
            batch_op.drop_constraint(CATEGORY_CONSTRAINT, type_="check")

    columns = {column["name"] for column in sa.inspect(connection).get_columns("tool_material_items")}
    if "category" in columns:
        op.drop_column("tool_material_items", "category")
