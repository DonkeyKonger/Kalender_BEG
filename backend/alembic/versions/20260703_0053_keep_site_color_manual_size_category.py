"""Keep site color as manual project size category.

Revision ID: 20260703_0053
Revises: 20260629_0052
Create Date: 2026-07-03
"""

from collections.abc import Sequence


revision: str = "20260703_0053"
down_revision: str | None = "20260629_0052"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
