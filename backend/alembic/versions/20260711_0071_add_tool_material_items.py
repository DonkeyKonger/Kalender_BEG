"""Add tool material items.

Revision ID: 20260711_0071
Revises: 20260710_0070
Create Date: 2026-07-11
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260711_0071"
down_revision: str | None = "20260710_0070"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    connection = op.get_bind()
    tables = set(sa.inspect(connection).get_table_names())
    if "tool_material_items" in tables:
        return

    op.create_table(
        "tool_material_items",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("manufacturer", sa.String(length=200), nullable=True),
        sa.Column("designation", sa.String(length=240), nullable=False),
        sa.Column("item_type", sa.String(length=160), nullable=True),
        sa.Column("device_number", sa.String(length=120), nullable=True),
        sa.Column("serial_number", sa.String(length=160), nullable=True),
        sa.Column("employee_id", sa.Integer(), nullable=True),
        sa.Column("item_date", sa.Date(), nullable=True),
        sa.Column("delivery_note", sa.String(length=160), nullable=True),
        sa.Column("remarks", sa.Text(), nullable=True),
        sa.Column("supplier", sa.String(length=200), nullable=True),
        sa.Column("invoice_number", sa.String(length=160), nullable=True),
        sa.Column("stock", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["employee_id"], ["persons.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_tool_material_items_manufacturer", "tool_material_items", ["manufacturer"])
    op.create_index("ix_tool_material_items_designation", "tool_material_items", ["designation"])
    op.create_index("ix_tool_material_items_item_type", "tool_material_items", ["item_type"])
    op.create_index("ix_tool_material_items_device_number", "tool_material_items", ["device_number"])
    op.create_index("ix_tool_material_items_serial_number", "tool_material_items", ["serial_number"])
    op.create_index("ix_tool_material_items_employee_id", "tool_material_items", ["employee_id"])
    op.create_index("ix_tool_material_items_supplier", "tool_material_items", ["supplier"])
    op.create_index("ix_tool_material_items_invoice_number", "tool_material_items", ["invoice_number"])


def downgrade() -> None:
    connection = op.get_bind()
    tables = set(sa.inspect(connection).get_table_names())
    if "tool_material_items" in tables:
        op.drop_table("tool_material_items")
