"""Add person employment status.

Revision ID: 20260705_0058
Revises: 20260704_0057
Create Date: 2026-07-05
"""

from collections.abc import Sequence


revision: str = "20260705_0058"
down_revision: str | None = "20260704_0057"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
