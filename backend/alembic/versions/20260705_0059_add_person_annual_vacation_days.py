"""Add person annual vacation days.

Revision ID: 20260705_0059
Revises: 20260705_0058
Create Date: 2026-07-05
"""

from collections.abc import Sequence


revision: str = "20260705_0059"
down_revision: str | None = "20260705_0058"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
