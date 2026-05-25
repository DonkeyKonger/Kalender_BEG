"""Add project folders.

Revision ID: 20260525_0009
Revises: 20260525_0008
Create Date: 2026-05-25
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260525_0009"
down_revision: str | None = "20260525_0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "project_folders",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("site_id", sa.Integer(), sa.ForeignKey("sites.id", ondelete="CASCADE"), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("folder_key", sa.String(length=80), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("external_provider", sa.String(length=80), nullable=True),
        sa.Column("external_drive_id", sa.String(length=200), nullable=True),
        sa.Column("external_item_id", sa.String(length=200), nullable=True),
        sa.Column("external_web_url", sa.String(length=500), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("site_id", "folder_key", name="uq_project_folders_site_key"),
    )
    op.create_index("ix_project_folders_site_id", "project_folders", ["site_id"])
    op.create_index("ix_project_folders_folder_key", "project_folders", ["folder_key"])


def downgrade() -> None:
    op.drop_index("ix_project_folders_folder_key", table_name="project_folders")
    op.drop_index("ix_project_folders_site_id", table_name="project_folders")
    op.drop_table("project_folders")
