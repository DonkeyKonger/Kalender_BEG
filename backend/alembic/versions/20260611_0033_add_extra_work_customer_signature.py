"""Add extra work customer signature fields.

Revision ID: 20260611_0033
Revises: 20260611_0032
Create Date: 2026-06-11 00:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260611_0033"
down_revision: str | None = "20260611_0032"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("extra_work_tickets", sa.Column("customer_signature_type", sa.String(length=60), nullable=True))
    op.add_column("extra_work_tickets", sa.Column("customer_signature_name", sa.String(length=160), nullable=True))
    op.add_column("extra_work_tickets", sa.Column("customer_signature_place", sa.String(length=160), nullable=True))
    op.add_column("extra_work_tickets", sa.Column("customer_signature_strokes", sa.JSON(), nullable=True))
    op.add_column("extra_work_tickets", sa.Column("customer_signed_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("extra_work_tickets", "customer_signed_at")
    op.drop_column("extra_work_tickets", "customer_signature_strokes")
    op.drop_column("extra_work_tickets", "customer_signature_place")
    op.drop_column("extra_work_tickets", "customer_signature_name")
    op.drop_column("extra_work_tickets", "customer_signature_type")
