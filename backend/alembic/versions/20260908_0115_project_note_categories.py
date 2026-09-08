"""Separate internal project notes and worker-visible note blocks.

Revision ID: 20260908_0115
Revises: 20260907_0114
"""
from alembic import op
import sqlalchemy as sa

revision = "20260908_0115"
down_revision = "20260907_0114"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "site_internal_notes",
        sa.Column("site_id", sa.Integer(), sa.ForeignKey("sites.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_table(
        "site_note_blocks",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("site_id", sa.Integer(), sa.ForeignKey("sites.id", ondelete="CASCADE"), nullable=False),
        sa.Column("number", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(120), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("visible_to_workers", sa.Boolean(), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("site_id", "number", name="uq_site_note_block_number"),
    )
    op.create_index("ix_site_note_blocks_site_id", "site_note_blocks", ["site_id"])


def downgrade():
    op.drop_table("site_note_blocks")
    op.drop_table("site_internal_notes")
