"""Add persistent captions for project-folder photos.

Revision ID: 20260821_0100
Revises: 20260819_0099
Create Date: 2026-08-21
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260821_0100"
down_revision: str | None = "20260819_0099"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


TABLE_NAME = "project_folder_document_captions"


def upgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if TABLE_NAME in inspector.get_table_names():
        return
    op.create_table(
        TABLE_NAME,
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("site_id", sa.Integer(), nullable=False),
        sa.Column("folder_key", sa.String(length=80), nullable=False),
        sa.Column("external_item_id", sa.String(length=255), nullable=False),
        sa.Column("caption", sa.String(length=500), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["site_id"], ["sites.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "site_id",
            "folder_key",
            "external_item_id",
            name="uq_project_folder_document_caption_item",
        ),
    )
    op.create_index(
        op.f("ix_project_folder_document_captions_site_id"),
        TABLE_NAME,
        ["site_id"],
        unique=False,
    )


def downgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if TABLE_NAME not in inspector.get_table_names():
        return
    op.drop_index(op.f("ix_project_folder_document_captions_site_id"), table_name=TABLE_NAME)
    op.drop_table(TABLE_NAME)
