"""Add operational project-manager absences.

Revision ID: 20260811_0094
Revises: 20260802_0093
Create Date: 2026-08-11
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260811_0094"
down_revision: str | None = "20260802_0093"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    connection = op.get_bind()
    if "operational_absences" in sa.inspect(connection).get_table_names():
        return

    op.create_table(
        "operational_absences",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("project_manager_id", sa.Integer(), nullable=False),
        sa.Column("absence_date", sa.Date(), nullable=False),
        sa.Column("start_time", sa.Time(), nullable=True),
        sa.Column("end_time", sa.Time(), nullable=True),
        sa.Column("site_id", sa.Integer(), nullable=True),
        sa.Column("text", sa.Text(), nullable=True),
        sa.Column("created_by_user_id", sa.Integer(), nullable=True),
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
        sa.CheckConstraint(
            "(start_time IS NULL AND end_time IS NULL) OR "
            "(start_time IS NOT NULL AND end_time IS NOT NULL AND end_time > start_time)",
            name="ck_operational_absences_time_range",
        ),
        sa.ForeignKeyConstraint(
            ["project_manager_id"],
            ["persons.id"],
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(["site_id"], ["sites.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(
            ["created_by_user_id"],
            ["users.id"],
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_operational_absences_date_project_manager",
        "operational_absences",
        ["absence_date", "project_manager_id"],
    )


def downgrade() -> None:
    connection = op.get_bind()
    if "operational_absences" in sa.inspect(connection).get_table_names():
        op.drop_table("operational_absences")
