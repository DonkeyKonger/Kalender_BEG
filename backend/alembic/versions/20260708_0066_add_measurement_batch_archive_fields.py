"""Add measurement batch archive fields.

Revision ID: 20260708_0066
Revises: 20260708_0065
Create Date: 2026-07-08
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260708_0066"
down_revision: str | None = "20260708_0065"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    connection = op.get_bind()
    tables = set(sa.inspect(connection).get_table_names())
    if "site_measurement_batches" not in tables:
        return
    columns = {
        column["name"]
        for column in sa.inspect(connection).get_columns("site_measurement_batches")
    }
    if "deleted_at" not in columns:
        op.add_column(
            "site_measurement_batches",
            sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        )
        op.create_index(
            "ix_site_measurement_batches_deleted_at",
            "site_measurement_batches",
            ["deleted_at"],
        )
    if "deleted_by_user_id" not in columns:
        op.add_column(
            "site_measurement_batches",
            sa.Column("deleted_by_user_id", sa.Integer(), nullable=True),
        )
        op.create_index(
            "ix_site_measurement_batches_deleted_by_user_id",
            "site_measurement_batches",
            ["deleted_by_user_id"],
        )
        op.create_foreign_key(
            "fk_site_measurement_batches_deleted_by_user_id",
            "site_measurement_batches",
            "users",
            ["deleted_by_user_id"],
            ["id"],
            ondelete="SET NULL",
        )


def downgrade() -> None:
    connection = op.get_bind()
    tables = set(sa.inspect(connection).get_table_names())
    if "site_measurement_batches" not in tables:
        return
    columns = {
        column["name"]
        for column in sa.inspect(connection).get_columns("site_measurement_batches")
    }
    if "deleted_by_user_id" in columns:
        op.drop_constraint(
            "fk_site_measurement_batches_deleted_by_user_id",
            "site_measurement_batches",
            type_="foreignkey",
        )
        op.drop_index("ix_site_measurement_batches_deleted_by_user_id", table_name="site_measurement_batches")
        op.drop_column("site_measurement_batches", "deleted_by_user_id")
    if "deleted_at" in columns:
        op.drop_index("ix_site_measurement_batches_deleted_at", table_name="site_measurement_batches")
        op.drop_column("site_measurement_batches", "deleted_at")
