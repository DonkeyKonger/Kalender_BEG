"""Add archive metadata to extra work tickets.

Revision ID: 20260818_0097
Revises: 20260817_0096
Create Date: 2026-08-18
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260818_0097"
down_revision: str | None = "20260817_0096"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if "extra_work_tickets" not in inspector.get_table_names():
        return

    columns = {
        column["name"]
        for column in inspector.get_columns("extra_work_tickets")
    }
    indexes = {
        index["name"]
        for index in inspector.get_indexes("extra_work_tickets")
    }

    if "deleted_at" not in columns:
        with op.batch_alter_table("extra_work_tickets") as batch_op:
            batch_op.add_column(
                sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True)
            )
    if "ix_extra_work_tickets_deleted_at" not in indexes:
        op.create_index(
            "ix_extra_work_tickets_deleted_at",
            "extra_work_tickets",
            ["deleted_at"],
        )

    if "deleted_by_user_id" not in columns:
        with op.batch_alter_table("extra_work_tickets") as batch_op:
            batch_op.add_column(
                sa.Column("deleted_by_user_id", sa.Integer(), nullable=True)
            )
            batch_op.create_foreign_key(
                "fk_extra_work_tickets_deleted_by_user_id",
                "users",
                ["deleted_by_user_id"],
                ["id"],
                ondelete="SET NULL",
            )
    if "ix_extra_work_tickets_deleted_by_user_id" not in indexes:
        op.create_index(
            "ix_extra_work_tickets_deleted_by_user_id",
            "extra_work_tickets",
            ["deleted_by_user_id"],
        )


def downgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if "extra_work_tickets" not in inspector.get_table_names():
        return

    columns = {
        column["name"]
        for column in inspector.get_columns("extra_work_tickets")
    }
    indexes = {
        index["name"]
        for index in inspector.get_indexes("extra_work_tickets")
    }

    if "deleted_by_user_id" in columns:
        with op.batch_alter_table("extra_work_tickets") as batch_op:
            if "ix_extra_work_tickets_deleted_by_user_id" in indexes:
                batch_op.drop_index("ix_extra_work_tickets_deleted_by_user_id")
            batch_op.drop_constraint(
                "fk_extra_work_tickets_deleted_by_user_id",
                type_="foreignkey",
            )
            batch_op.drop_column("deleted_by_user_id")

    if "deleted_at" in columns:
        with op.batch_alter_table("extra_work_tickets") as batch_op:
            if "ix_extra_work_tickets_deleted_at" in indexes:
                batch_op.drop_index("ix_extra_work_tickets_deleted_at")
            batch_op.drop_column("deleted_at")
