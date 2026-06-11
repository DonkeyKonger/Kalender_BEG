"""Add self-planned assignment type.

Revision ID: 20260611_0030
Revises: 20260611_0029
Create Date: 2026-06-11
"""

from collections.abc import Sequence

from alembic import op

revision: str = "20260611_0030"
down_revision: str | None = "20260611_0029"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE assignment_type ADD VALUE IF NOT EXISTS 'self_planned'")


def downgrade() -> None:
    # PostgreSQL enum values cannot be removed safely without rebuilding the type.
    pass
