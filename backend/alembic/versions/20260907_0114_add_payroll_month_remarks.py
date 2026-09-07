"""Store office remarks on each worker's payroll month.

Revision ID: 20260907_0114
Revises: 20260905_0113
"""
from alembic import op
import sqlalchemy as sa

revision = "20260907_0114"
down_revision = "20260905_0113"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("payroll_month_person_approvals", sa.Column("remarks", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("payroll_month_person_approvals", "remarks")
