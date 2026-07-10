"""Require dashboard note owner.

Revision ID: 20260710_0070
Revises: 20260710_0069
Create Date: 2026-07-10
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260710_0070"
down_revision: str | None = "20260710_0069"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    tables = set(inspector.get_table_names())
    if "dashboard_notes" not in tables:
        return

    columns = {column["name"]: column for column in inspector.get_columns("dashboard_notes")}
    if "created_by_user_id" not in columns:
        return

    fallback_user_id = None
    if "users" in tables:
        fallback_user_id = connection.scalar(
            sa.text(
                "SELECT id FROM users "
                "WHERE role = 'admin' AND is_active IS TRUE "
                "ORDER BY id LIMIT 1"
            )
        )
        if fallback_user_id is None:
            fallback_user_id = connection.scalar(
                sa.text(
                    "SELECT id FROM users "
                    "WHERE is_active IS TRUE "
                    "ORDER BY id LIMIT 1"
                )
            )
        if fallback_user_id is None:
            fallback_user_id = connection.scalar(
                sa.text("SELECT id FROM users ORDER BY id LIMIT 1")
            )

    if fallback_user_id is None:
        connection.execute(sa.text("DELETE FROM dashboard_notes WHERE created_by_user_id IS NULL"))
    else:
        connection.execute(
            sa.text(
                "UPDATE dashboard_notes "
                "SET created_by_user_id = :user_id "
                "WHERE created_by_user_id IS NULL"
            ),
            {"user_id": fallback_user_id},
        )

    if columns["created_by_user_id"].get("nullable", True):
        with op.batch_alter_table("dashboard_notes") as batch_op:
            batch_op.alter_column(
                "created_by_user_id",
                existing_type=sa.Integer(),
                nullable=False,
            )


def downgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    tables = set(inspector.get_table_names())
    if "dashboard_notes" not in tables:
        return
    columns = {column["name"]: column for column in inspector.get_columns("dashboard_notes")}
    if "created_by_user_id" in columns and not columns["created_by_user_id"].get("nullable", True):
        with op.batch_alter_table("dashboard_notes") as batch_op:
            batch_op.alter_column(
                "created_by_user_id",
                existing_type=sa.Integer(),
                nullable=True,
            )
