"""Add customer soft-delete tombstone fields.

Revision ID: 20260629_0052
Revises: 20260626_0051
Create Date: 2026-06-29
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260629_0052"
down_revision: str | None = "20260626_0051"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("customers", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("customers", sa.Column("deleted_by", sa.Integer(), nullable=True))
    op.add_column("customers", sa.Column("deleted_tombstone_id", sa.String(length=255), nullable=True))
    op.create_foreign_key(
        "fk_customers_deleted_by_users",
        "customers",
        "users",
        ["deleted_by"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_customers_deleted_at", "customers", ["deleted_at"])
    op.create_index("ix_customers_deleted_tombstone_id", "customers", ["deleted_tombstone_id"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_customers_deleted_tombstone_id", table_name="customers")
    op.drop_index("ix_customers_deleted_at", table_name="customers")
    op.drop_constraint("fk_customers_deleted_by_users", "customers", type_="foreignkey")
    op.drop_column("customers", "deleted_tombstone_id")
    op.drop_column("customers", "deleted_by")
    op.drop_column("customers", "deleted_at")
