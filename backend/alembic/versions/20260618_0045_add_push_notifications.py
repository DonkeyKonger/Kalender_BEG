"""Add push notification device and pending plan notification tables.

Revision ID: 20260618_0045
Revises: 20260616_0044
Create Date: 2026-06-18
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260618_0045"
down_revision: str | None = "20260616_0044"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "user_push_devices",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("platform", sa.String(length=40), nullable=False),
        sa.Column("token", sa.Text(), nullable=False),
        sa.Column("device_id", sa.String(length=160), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("token"),
    )
    op.create_index("ix_user_push_devices_user_id", "user_push_devices", ["user_id"])
    op.create_index("ix_user_push_devices_device_id", "user_push_devices", ["device_id"])
    op.create_index("ix_user_push_devices_is_active", "user_push_devices", ["is_active"])
    op.alter_column("user_push_devices", "is_active", server_default=None)

    op.create_table(
        "pending_plan_push_notifications",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("user_id", sa.Integer(), nullable=False),
        sa.Column("change_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("first_changed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_changed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_pending_plan_push_notifications_user_id",
        "pending_plan_push_notifications",
        ["user_id"],
    )
    op.create_index(
        "ix_pending_plan_push_notifications_sent_at",
        "pending_plan_push_notifications",
        ["sent_at"],
    )
    op.alter_column("pending_plan_push_notifications", "change_count", server_default=None)


def downgrade() -> None:
    op.drop_index(
        "ix_pending_plan_push_notifications_sent_at",
        table_name="pending_plan_push_notifications",
    )
    op.drop_index(
        "ix_pending_plan_push_notifications_user_id",
        table_name="pending_plan_push_notifications",
    )
    op.drop_table("pending_plan_push_notifications")
    op.drop_index("ix_user_push_devices_is_active", table_name="user_push_devices")
    op.drop_index("ix_user_push_devices_device_id", table_name="user_push_devices")
    op.drop_index("ix_user_push_devices_user_id", table_name="user_push_devices")
    op.drop_table("user_push_devices")
