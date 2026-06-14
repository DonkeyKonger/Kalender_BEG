"""Add time entry payroll row review.

Revision ID: 20260614_0040
Revises: 20260614_0039
Create Date: 2026-06-14
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260614_0040"
down_revision: str | None = "20260614_0039"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("work_time_entries", sa.Column("payroll_reviewed_by_user_id", sa.Integer(), nullable=True))
    op.add_column("work_time_entries", sa.Column("payroll_reviewed_at", sa.DateTime(timezone=True), nullable=True))
    op.create_foreign_key(
        "fk_work_time_entries_payroll_reviewed_by_user_id_users",
        "work_time_entries",
        "users",
        ["payroll_reviewed_by_user_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index(
        "ix_work_time_entries_payroll_reviewed_by_user_id",
        "work_time_entries",
        ["payroll_reviewed_by_user_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_work_time_entries_payroll_reviewed_by_user_id", table_name="work_time_entries")
    op.drop_constraint(
        "fk_work_time_entries_payroll_reviewed_by_user_id_users",
        "work_time_entries",
        type_="foreignkey",
    )
    op.drop_column("work_time_entries", "payroll_reviewed_at")
    op.drop_column("work_time_entries", "payroll_reviewed_by_user_id")
