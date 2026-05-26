"""Add site project folder metadata.

Revision ID: 20260526_0010
Revises: 20260525_0009
Create Date: 2026-05-26
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260526_0010"
down_revision: str | None = "20260525_0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("sites", sa.Column("project_folder_id", sa.String(length=200), nullable=True))
    op.add_column("sites", sa.Column("project_folder_web_url", sa.String(length=500), nullable=True))
    op.add_column("sites", sa.Column("project_folder_name", sa.String(length=200), nullable=True))
    op.add_column(
        "sites",
        sa.Column(
            "project_folder_status",
            sa.String(length=40),
            nullable=False,
            server_default="not_configured",
        ),
    )
    op.add_column("sites", sa.Column("project_folder_error", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("sites", "project_folder_error")
    op.drop_column("sites", "project_folder_status")
    op.drop_column("sites", "project_folder_name")
    op.drop_column("sites", "project_folder_web_url")
    op.drop_column("sites", "project_folder_id")
