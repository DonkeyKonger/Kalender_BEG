"""Add dashboard message dismissals.

Revision ID: 20260612_0038
Revises: 20260612_0037
Create Date: 2026-06-12
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260612_0038"
down_revision: str | None = "20260612_0037"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "dashboard_message_dismissals",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("message_type", sa.String(length=80), nullable=False),
        sa.Column("message_key", sa.String(length=160), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "message_key", name="uq_dashboard_message_dismissals_user_key"),
    )
    op.create_index(
        "ix_dashboard_message_dismissals_user_type",
        "dashboard_message_dismissals",
        ["user_id", "message_type"],
    )


def downgrade() -> None:
    op.drop_index("ix_dashboard_message_dismissals_user_type", table_name="dashboard_message_dismissals")
    op.drop_table("dashboard_message_dismissals")
