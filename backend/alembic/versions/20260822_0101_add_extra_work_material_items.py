"""Add structured material items to extra-work entries.

Revision ID: 20260822_0101
Revises: 20260821_0100
Create Date: 2026-08-22
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260822_0101"
down_revision: str | None = "20260821_0100"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


TABLE_NAME = "extra_work_ticket_entries"
COLUMN_NAME = "material_items"


def upgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if TABLE_NAME not in inspector.get_table_names():
        return
    existing_columns = {
        column["name"] for column in inspector.get_columns(TABLE_NAME)
    }
    if COLUMN_NAME not in existing_columns:
        # Nullable by design: existing rows and older clients retain their
        # untouched material_text without requiring a data rewrite.
        op.add_column(
            TABLE_NAME,
            sa.Column(COLUMN_NAME, sa.JSON(), nullable=True),
        )


def downgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if TABLE_NAME not in inspector.get_table_names():
        return
    existing_columns = {
        column["name"] for column in inspector.get_columns(TABLE_NAME)
    }
    if COLUMN_NAME in existing_columns:
        op.drop_column(TABLE_NAME, COLUMN_NAME)
