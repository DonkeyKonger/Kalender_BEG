"""Share dashboard notes with one office user.

Revision ID: 20260713_0073
Revises: 20260713_0072
Create Date: 2026-07-13
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260713_0073"
down_revision: str | None = "20260713_0072"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SHARED_INDEX_NAME = "ix_dashboard_notes_shared_with_user_id"
SHARED_OPEN_SITE_INDEX_NAME = "ix_dashboard_notes_shared_open_site"


def upgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if "dashboard_notes" not in inspector.get_table_names():
        return

    columns = {column["name"] for column in inspector.get_columns("dashboard_notes")}
    with op.batch_alter_table("dashboard_notes") as batch_op:
        if "shared_with_user_id" not in columns:
            batch_op.add_column(sa.Column("shared_with_user_id", sa.Integer(), nullable=True))
            batch_op.create_foreign_key(
                "fk_dashboard_notes_shared_with_user_id_users",
                "users",
                ["shared_with_user_id"],
                ["id"],
                ondelete="SET NULL",
            )
        if "share_revision" not in columns:
            batch_op.add_column(
                sa.Column("share_revision", sa.Integer(), nullable=False, server_default="0")
            )
        if "shared_at" not in columns:
            batch_op.add_column(sa.Column("shared_at", sa.DateTime(timezone=True), nullable=True))

    inspector = sa.inspect(connection)
    indexes = {index["name"] for index in inspector.get_indexes("dashboard_notes")}
    if SHARED_INDEX_NAME not in indexes:
        op.create_index(SHARED_INDEX_NAME, "dashboard_notes", ["shared_with_user_id"])
    if SHARED_OPEN_SITE_INDEX_NAME not in indexes:
        op.create_index(
            SHARED_OPEN_SITE_INDEX_NAME,
            "dashboard_notes",
            ["shared_with_user_id", "completed", "deleted_at", "site_id"],
        )


def downgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if "dashboard_notes" not in inspector.get_table_names():
        return

    indexes = {index["name"] for index in inspector.get_indexes("dashboard_notes")}
    if SHARED_OPEN_SITE_INDEX_NAME in indexes:
        op.drop_index(SHARED_OPEN_SITE_INDEX_NAME, table_name="dashboard_notes")
    if SHARED_INDEX_NAME in indexes:
        op.drop_index(SHARED_INDEX_NAME, table_name="dashboard_notes")

    columns = {column["name"] for column in inspector.get_columns("dashboard_notes")}
    with op.batch_alter_table("dashboard_notes") as batch_op:
        if "shared_at" in columns:
            batch_op.drop_column("shared_at")
        if "share_revision" in columns:
            batch_op.drop_column("share_revision")
        if "shared_with_user_id" in columns:
            batch_op.drop_column("shared_with_user_id")
