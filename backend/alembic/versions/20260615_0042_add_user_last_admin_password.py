"""Add last admin password field to users.

Revision ID: 20260615_0042
Revises: 20260614_0041
Create Date: 2026-06-15
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260615_0042"
down_revision: str | None = "20260614_0041"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("last_admin_password_plain", sa.String(length=200), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "last_admin_password_plain")
