"""Index the tool material date used by table filters and sorting.

Revision ID: 20260717_0090
Revises: 20260717_0089
Create Date: 2026-07-17
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260717_0090"
down_revision: str | None = "20260717_0089"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

INDEX_NAME = "ix_tool_material_items_item_date"


def upgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if "tool_material_items" not in inspector.get_table_names():
        return
    indexes = {index["name"] for index in inspector.get_indexes("tool_material_items")}
    if INDEX_NAME not in indexes:
        op.create_index(INDEX_NAME, "tool_material_items", ["item_date"], unique=False)


def downgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if "tool_material_items" not in inspector.get_table_names():
        return
    indexes = {index["name"] for index in inspector.get_indexes("tool_material_items")}
    if INDEX_NAME in indexes:
        op.drop_index(INDEX_NAME, table_name="tool_material_items")
