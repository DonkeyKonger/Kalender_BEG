"""Add the per-person work-day overnight status.

Revision ID: 20260817_0096
Revises: 20260811_0095
Create Date: 2026-08-17
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260817_0096"
down_revision: str | None = "20260811_0095"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    connection = op.get_bind()
    if "person_work_days" in sa.inspect(connection).get_table_names():
        return

    op.create_table(
        "person_work_days",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("person_id", sa.Integer(), nullable=False),
        sa.Column("work_date", sa.Date(), nullable=False),
        sa.Column("overnight_status", sa.String(length=32), nullable=True),
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
            "overnight_status IS NULL OR overnight_status IN ('none', 'self_paid', 'beg_paid')",
            name="ck_person_work_days_overnight_status",
        ),
        sa.ForeignKeyConstraint(["person_id"], ["persons.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "person_id",
            "work_date",
            name="uq_person_work_days_person_date",
        ),
    )
    op.create_index(
        "ix_person_work_days_person_id",
        "person_work_days",
        ["person_id"],
    )
    op.create_index(
        "ix_person_work_days_work_date",
        "person_work_days",
        ["work_date"],
    )


def downgrade() -> None:
    connection = op.get_bind()
    if "person_work_days" in sa.inspect(connection).get_table_names():
        op.drop_table("person_work_days")
