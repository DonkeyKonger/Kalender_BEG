"""Add global tool and material responsibility.

Revision ID: 20260715_0083
Revises: 20260715_0082
Create Date: 2026-07-15
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260715_0083"
down_revision: str | None = "20260715_0082"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    connection = op.get_bind()
    tables = set(sa.inspect(connection).get_table_names())
    if "tool_material_settings" in tables:
        return

    settings_table = op.create_table(
        "tool_material_settings",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("tool_responsible_user_id", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint("id = 1", name="ck_tool_material_settings_singleton"),
        sa.ForeignKeyConstraint(
            ["tool_responsible_user_id"],
            ["users.id"],
            name="fk_tool_material_settings_responsible_user",
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.bulk_insert(
        settings_table,
        [{"id": 1, "tool_responsible_user_id": None}],
    )


def downgrade() -> None:
    connection = op.get_bind()
    tables = set(sa.inspect(connection).get_table_names())
    if "tool_material_settings" in tables:
        op.drop_table("tool_material_settings")
