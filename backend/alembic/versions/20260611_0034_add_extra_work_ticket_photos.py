"""add extra work ticket photos

Revision ID: 20260611_0034
Revises: 20260611_0033
Create Date: 2026-06-11
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260611_0034"
down_revision: str | None = "20260611_0033"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "extra_work_ticket_photos",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("site_id", sa.Integer(), nullable=False),
        sa.Column("extra_work_ticket_id", sa.Integer(), nullable=False),
        sa.Column("uploaded_by_user_id", sa.Integer(), nullable=True),
        sa.Column("project_folder_key", sa.String(length=80), nullable=False),
        sa.Column("external_drive_id", sa.String(length=255), nullable=False),
        sa.Column("external_item_id", sa.String(length=255), nullable=False),
        sa.Column("external_web_url", sa.String(length=1000), nullable=True),
        sa.Column("filename", sa.String(length=255), nullable=False),
        sa.Column("content_type", sa.String(length=120), nullable=False),
        sa.Column("file_size_bytes", sa.Integer(), nullable=True),
        sa.Column("caption", sa.String(length=500), nullable=True),
        sa.Column("taken_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["extra_work_ticket_id"], ["extra_work_tickets.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["site_id"], ["sites.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["uploaded_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_extra_work_ticket_photos_extra_work_ticket_id"),
        "extra_work_ticket_photos",
        ["extra_work_ticket_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_extra_work_ticket_photos_site_id"),
        "extra_work_ticket_photos",
        ["site_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_extra_work_ticket_photos_uploaded_by_user_id"),
        "extra_work_ticket_photos",
        ["uploaded_by_user_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_extra_work_ticket_photos_uploaded_by_user_id"), table_name="extra_work_ticket_photos")
    op.drop_index(op.f("ix_extra_work_ticket_photos_site_id"), table_name="extra_work_ticket_photos")
    op.drop_index(op.f("ix_extra_work_ticket_photos_extra_work_ticket_id"), table_name="extra_work_ticket_photos")
    op.drop_table("extra_work_ticket_photos")
