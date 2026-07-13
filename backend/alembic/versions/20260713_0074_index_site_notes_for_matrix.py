"""Index site notes for shared matrix visibility.

Revision ID: 20260713_0074
Revises: 20260713_0073
Create Date: 2026-07-13
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260713_0074"
down_revision: str | None = "20260713_0073"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

INDEX_NAME = "ix_dashboard_notes_site_open"


def upgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if "dashboard_notes" not in inspector.get_table_names():
        return
    indexes = {index["name"] for index in inspector.get_indexes("dashboard_notes")}
    if INDEX_NAME not in indexes:
        op.create_index(
            INDEX_NAME,
            "dashboard_notes",
            ["site_id", "completed", "deleted_at"],
        )


def downgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if "dashboard_notes" not in inspector.get_table_names():
        return
    indexes = {index["name"] for index in inspector.get_indexes("dashboard_notes")}
    if INDEX_NAME in indexes:
        op.drop_index(INDEX_NAME, table_name="dashboard_notes")
