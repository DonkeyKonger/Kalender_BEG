"""Add project email recipients.

Revision ID: 20260612_0037
Revises: 20260611_0036
Create Date: 2026-06-12
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260612_0037"
down_revision: str | None = "20260611_0036"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "site_email_recipients",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("site_id", sa.Integer(), nullable=False),
        sa.Column("email", sa.String(length=255), nullable=False),
        sa.Column("label", sa.String(length=200), nullable=True),
        sa.Column("source", sa.String(length=80), nullable=True),
        sa.Column("is_selected", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["site_id"], ["sites.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("site_id", "email", name="uq_site_email_recipients_site_email"),
    )
    op.create_index("ix_site_email_recipients_site_id", "site_email_recipients", ["site_id"])


def downgrade() -> None:
    op.drop_index("ix_site_email_recipients_site_id", table_name="site_email_recipients")
    op.drop_table("site_email_recipients")
