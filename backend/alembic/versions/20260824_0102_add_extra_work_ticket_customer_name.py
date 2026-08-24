"""Add a ticket-specific customer name to extra-work tickets.

Revision ID: 20260824_0102
Revises: 20260822_0101
Create Date: 2026-08-24
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260824_0102"
down_revision: str | None = "20260822_0101"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


TABLE_NAME = "extra_work_tickets"
COLUMN_NAME = "customer_name"


def upgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if TABLE_NAME not in inspector.get_table_names():
        return
    existing_columns = {
        column["name"] for column in inspector.get_columns(TABLE_NAME)
    }
    if COLUMN_NAME not in existing_columns:
        # Keep existing tickets null so they continue to resolve the current
        # site customer as their backwards-compatible display fallback.
        op.add_column(
            TABLE_NAME,
            sa.Column(COLUMN_NAME, sa.String(length=200), nullable=True),
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
