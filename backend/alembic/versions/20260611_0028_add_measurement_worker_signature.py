"""add measurement worker signature

Revision ID: 20260611_0028
Revises: 20260610_0027
Create Date: 2026-06-11
"""

from alembic import op
import sqlalchemy as sa


revision = "20260611_0028"
down_revision = "20260610_0027"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("site_measurement_batches", sa.Column("worker_signed_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("site_measurement_batches", sa.Column("worker_signature_name", sa.String(length=160), nullable=True))
    op.add_column("site_measurement_batches", sa.Column("worker_signature_strokes", sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column("site_measurement_batches", "worker_signature_strokes")
    op.drop_column("site_measurement_batches", "worker_signature_name")
    op.drop_column("site_measurement_batches", "worker_signed_at")
