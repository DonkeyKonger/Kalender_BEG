"""Add BEG number to tool material items.

Revision ID: 20260715_0076
Revises: 20260714_0075
Create Date: 2026-07-15
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260715_0076"
down_revision: str | None = "20260714_0075"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if "tool_material_items" not in inspector.get_table_names():
        return

    columns = {column["name"] for column in inspector.get_columns("tool_material_items")}
    if "beg_number" not in columns:
        op.add_column(
            "tool_material_items",
            sa.Column("beg_number", sa.String(length=120), nullable=True),
        )

    indexes = {index["name"] for index in sa.inspect(connection).get_indexes("tool_material_items")}
    if "ix_tool_material_items_beg_number" not in indexes:
        op.create_index(
            "ix_tool_material_items_beg_number",
            "tool_material_items",
            ["beg_number"],
            unique=True,
        )


def downgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if "tool_material_items" not in inspector.get_table_names():
        return

    indexes = {index["name"] for index in inspector.get_indexes("tool_material_items")}
    if "ix_tool_material_items_beg_number" in indexes:
        op.drop_index("ix_tool_material_items_beg_number", table_name="tool_material_items")

    columns = {column["name"] for column in sa.inspect(connection).get_columns("tool_material_items")}
    if "beg_number" in columns:
        op.drop_column("tool_material_items", "beg_number")
