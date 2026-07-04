"""Add customer email labels.

Revision ID: 20260704_0055
Revises: 20260704_0054
Create Date: 2026-07-04
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260704_0055"
down_revision: str | None = "20260704_0054"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "customer_email_labels",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("customer_id", sa.Integer(), nullable=False),
        sa.Column("email", sa.String(length=255), nullable=False),
        sa.Column("email_normalized", sa.String(length=255), nullable=False),
        sa.Column("label", sa.String(length=200), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["customer_id"], ["customers.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("customer_id", "email_normalized", name="uq_customer_email_labels_customer_email"),
    )
    op.create_index("ix_customer_email_labels_customer_id", "customer_email_labels", ["customer_id"])


def downgrade() -> None:
    op.drop_index("ix_customer_email_labels_customer_id", table_name="customer_email_labels")
    op.drop_table("customer_email_labels")
