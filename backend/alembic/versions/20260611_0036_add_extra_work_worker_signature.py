"""Add extra work worker signature fields.

Revision ID: 20260611_0036
Revises: 20260611_0035
Create Date: 2026-06-11
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260611_0036"
down_revision: str | None = "20260611_0035"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("extra_work_tickets", sa.Column("worker_signature_name", sa.String(length=160), nullable=True))
    op.add_column("extra_work_tickets", sa.Column("worker_signature_strokes", sa.JSON(), nullable=True))
    op.add_column("extra_work_tickets", sa.Column("worker_signed_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("extra_work_tickets", "worker_signed_at")
    op.drop_column("extra_work_tickets", "worker_signature_strokes")
    op.drop_column("extra_work_tickets", "worker_signature_name")
