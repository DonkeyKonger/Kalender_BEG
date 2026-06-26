"""Add customer reference to sites.

Revision ID: 20260626_0051
Revises: 20260625_0050
Create Date: 2026-06-26
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260626_0051"
down_revision: str | None = "20260625_0050"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("sites", sa.Column("customer_id", sa.Integer(), nullable=True))
    op.create_foreign_key(
        "fk_sites_customer_id_customers",
        "sites",
        "customers",
        ["customer_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_sites_customer_id", "sites", ["customer_id"])


def downgrade() -> None:
    op.drop_index("ix_sites_customer_id", table_name="sites")
    op.drop_constraint("fk_sites_customer_id_customers", "sites", type_="foreignkey")
    op.drop_column("sites", "customer_id")
