"""Index dashboard notes for matrix badges.

Revision ID: 20260713_0072
Revises: 20260711_0071
Create Date: 2026-07-13
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260713_0072"
down_revision: str | None = "20260711_0071"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

INDEX_NAME = "ix_dashboard_notes_owner_open_site"


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
            ["created_by_user_id", "completed", "deleted_at", "site_id"],
        )


def downgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if "dashboard_notes" not in inspector.get_table_names():
        return
    indexes = {index["name"] for index in inspector.get_indexes("dashboard_notes")}
    if INDEX_NAME in indexes:
        op.drop_index(INDEX_NAME, table_name="dashboard_notes")
