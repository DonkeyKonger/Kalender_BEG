"""Add the independent measurement invoiced marker.

Revision ID: 20260911_0116
Revises: 20260908_0115
Create Date: 2026-09-11
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260911_0116"
down_revision: str | None = "20260908_0115"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


TABLE_NAME = "site_measurement_batches"
COLUMN_NAME = "is_invoiced"


def upgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if TABLE_NAME not in inspector.get_table_names():
        return
    existing_columns = {column["name"] for column in inspector.get_columns(TABLE_NAME)}
    if COLUMN_NAME not in existing_columns:
        op.add_column(
            TABLE_NAME,
            sa.Column(
                COLUMN_NAME,
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            ),
        )


def downgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if TABLE_NAME not in inspector.get_table_names():
        return
    existing_columns = {column["name"] for column in inspector.get_columns(TABLE_NAME)}
    if COLUMN_NAME in existing_columns:
        op.drop_column(TABLE_NAME, COLUMN_NAME)
