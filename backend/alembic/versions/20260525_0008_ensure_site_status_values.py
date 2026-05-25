"""Ensure current site status enum values.

Revision ID: 20260525_0008
Revises: 20260523_0007
Create Date: 2026-05-25
"""

from collections.abc import Sequence

from alembic import op

revision: str = "20260525_0008"
down_revision: str | None = "20260523_0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE site_status ADD VALUE IF NOT EXISTS 'planned'")
        op.execute("ALTER TYPE site_status ADD VALUE IF NOT EXISTS 'completed'")
        op.execute("ALTER TYPE site_status ADD VALUE IF NOT EXISTS 'deleted'")
    op.execute("UPDATE sites SET status = 'completed' WHERE status IN ('closed', 'archived')")


def downgrade() -> None:
    op.execute("UPDATE sites SET status = 'active' WHERE status = 'planned'")
    op.execute("UPDATE sites SET status = 'completed' WHERE status = 'deleted'")
