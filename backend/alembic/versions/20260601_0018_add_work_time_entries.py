"""Add work time entries.

Revision ID: 20260601_0018
Revises: 20260601_0017
Create Date: 2026-06-01 13:10:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260601_0018"
down_revision: str | None = "20260601_0017"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "work_time_entries",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("person_id", sa.Integer(), nullable=False),
        sa.Column("site_id", sa.Integer(), nullable=True),
        sa.Column("assignment_id", sa.Integer(), nullable=True),
        sa.Column("work_date", sa.Date(), nullable=False),
        sa.Column("start_time", sa.Time(), nullable=True),
        sa.Column("end_time", sa.Time(), nullable=True),
        sa.Column("break_minutes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("travel_minutes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("work_minutes", sa.Integer(), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("source", sa.String(length=40), nullable=False, server_default="manual"),
        sa.Column("status", sa.String(length=40), nullable=False, server_default="draft"),
        sa.Column("created_by_user_id", sa.Integer(), nullable=True),
        sa.Column("reviewed_by_user_id", sa.Integer(), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["assignment_id"], ["assignments.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["person_id"], ["persons.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["reviewed_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["site_id"], ["sites.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_work_time_entries_assignment_id", "work_time_entries", ["assignment_id"])
    op.create_index("ix_work_time_entries_created_by_user_id", "work_time_entries", ["created_by_user_id"])
    op.create_index("ix_work_time_entries_person_date", "work_time_entries", ["person_id", "work_date"])
    op.create_index("ix_work_time_entries_person_id", "work_time_entries", ["person_id"])
    op.create_index("ix_work_time_entries_reviewed_by_user_id", "work_time_entries", ["reviewed_by_user_id"])
    op.create_index("ix_work_time_entries_site_date", "work_time_entries", ["site_id", "work_date"])
    op.create_index("ix_work_time_entries_site_id", "work_time_entries", ["site_id"])
    op.create_index("ix_work_time_entries_work_date", "work_time_entries", ["work_date"])


def downgrade() -> None:
    op.drop_index("ix_work_time_entries_work_date", table_name="work_time_entries")
    op.drop_index("ix_work_time_entries_site_id", table_name="work_time_entries")
    op.drop_index("ix_work_time_entries_site_date", table_name="work_time_entries")
    op.drop_index("ix_work_time_entries_reviewed_by_user_id", table_name="work_time_entries")
    op.drop_index("ix_work_time_entries_person_id", table_name="work_time_entries")
    op.drop_index("ix_work_time_entries_person_date", table_name="work_time_entries")
    op.drop_index("ix_work_time_entries_created_by_user_id", table_name="work_time_entries")
    op.drop_index("ix_work_time_entries_assignment_id", table_name="work_time_entries")
    op.drop_table("work_time_entries")
