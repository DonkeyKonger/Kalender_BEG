"""Add safe Excel import identity to tool/material items.

Revision ID: 20260717_0092
Revises: 20260717_0091
Create Date: 2026-07-17
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260717_0092"
down_revision: str | None = "20260717_0091"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if "tool_material_items" not in inspector.get_table_names():
        return

    indexes = {index["name"]: index for index in inspector.get_indexes("tool_material_items")}
    beg_index = indexes.get("ix_tool_material_items_beg_number")
    if beg_index and beg_index.get("unique"):
        op.drop_index("ix_tool_material_items_beg_number", table_name="tool_material_items")
        op.create_index(
            "ix_tool_material_items_beg_number",
            "tool_material_items",
            ["beg_number"],
            unique=False,
        )

    columns = {column["name"] for column in sa.inspect(connection).get_columns("tool_material_items")}
    with op.batch_alter_table("tool_material_items") as batch_op:
        if "import_source" not in columns:
            batch_op.add_column(sa.Column("import_source", sa.String(length=80), nullable=True))
        if "import_sheet" not in columns:
            batch_op.add_column(sa.Column("import_sheet", sa.String(length=80), nullable=True))
        if "import_row_number" not in columns:
            batch_op.add_column(sa.Column("import_row_number", sa.Integer(), nullable=True))
        if "import_key" not in columns:
            batch_op.add_column(sa.Column("import_key", sa.String(length=64), nullable=True))

    indexes = {index["name"] for index in sa.inspect(connection).get_indexes("tool_material_items")}
    if "ix_tool_material_items_import_source" not in indexes:
        op.create_index(
            "ix_tool_material_items_import_source",
            "tool_material_items",
            ["import_source"],
            unique=False,
        )
    if "ix_tool_material_items_import_key" not in indexes:
        op.create_index(
            "ix_tool_material_items_import_key",
            "tool_material_items",
            ["import_key"],
            unique=True,
        )


def downgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if "tool_material_items" not in inspector.get_table_names():
        return
    indexes = {index["name"]: index for index in inspector.get_indexes("tool_material_items")}
    for index_name in ("ix_tool_material_items_import_key", "ix_tool_material_items_import_source"):
        if index_name in indexes:
            op.drop_index(index_name, table_name="tool_material_items")
    with op.batch_alter_table("tool_material_items") as batch_op:
        columns = {column["name"] for column in sa.inspect(connection).get_columns("tool_material_items")}
        for column_name in ("import_key", "import_row_number", "import_sheet", "import_source"):
            if column_name in columns:
                batch_op.drop_column(column_name)
    indexes = {index["name"]: index for index in sa.inspect(connection).get_indexes("tool_material_items")}
    beg_index = indexes.get("ix_tool_material_items_beg_number")
    if beg_index and not beg_index.get("unique"):
        op.drop_index("ix_tool_material_items_beg_number", table_name="tool_material_items")
        op.create_index(
            "ix_tool_material_items_beg_number",
            "tool_material_items",
            ["beg_number"],
            unique=True,
        )
