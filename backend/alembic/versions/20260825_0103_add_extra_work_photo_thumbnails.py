"""Store compact previews for extra-work photos.

Revision ID: 20260825_0103
Revises: 20260824_0102
Create Date: 2026-08-25
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260825_0103"
down_revision: str | None = "20260824_0102"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


TABLE_NAME = "extra_work_ticket_photos"


def upgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if TABLE_NAME not in inspector.get_table_names():
        return
    existing_columns = {column["name"] for column in inspector.get_columns(TABLE_NAME)}
    if "thumbnail_content" not in existing_columns:
        op.add_column(TABLE_NAME, sa.Column("thumbnail_content", sa.LargeBinary(), nullable=True))
    if "thumbnail_content_type" not in existing_columns:
        op.add_column(
            TABLE_NAME,
            sa.Column("thumbnail_content_type", sa.String(length=120), nullable=True),
        )


def downgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if TABLE_NAME not in inspector.get_table_names():
        return
    existing_columns = {column["name"] for column in inspector.get_columns(TABLE_NAME)}
    if "thumbnail_content_type" in existing_columns:
        op.drop_column(TABLE_NAME, "thumbnail_content_type")
    if "thumbnail_content" in existing_columns:
        op.drop_column(TABLE_NAME, "thumbnail_content")
