"""Update site status model.

Revision ID: 20260523_0007
Revises: 20260521_0006
Create Date: 2026-05-23
"""

from collections.abc import Sequence

from alembic import op

revision: str = "20260523_0007"
down_revision: str | None = "20260521_0006"
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
    op.execute("UPDATE sites SET status = 'archived' WHERE status IN ('completed', 'deleted')")
