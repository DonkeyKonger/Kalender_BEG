"""Add person hours account entries.

Revision ID: 20260707_0063
Revises: 20260706_0062
Create Date: 2026-07-07
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260707_0063"
down_revision: str | None = "20260706_0062"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    connection = op.get_bind()
    tables = set(sa.inspect(connection).get_table_names())
    if "person_hours_account_entries" in tables:
        return
    op.create_table(
        "person_hours_account_entries",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("person_id", sa.Integer(), nullable=False),
        sa.Column("entry_type", sa.String(length=40), nullable=False),
        sa.Column("minutes_delta", sa.Integer(), nullable=False),
        sa.Column("balance_after_minutes", sa.Integer(), nullable=False),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column("iso_year", sa.Integer(), nullable=True),
        sa.Column("iso_week", sa.Integer(), nullable=True),
        sa.Column("weekly_review_id", sa.Integer(), nullable=True),
        sa.Column("weekly_actual_minutes", sa.Integer(), nullable=True),
        sa.Column("weekly_required_minutes", sa.Integer(), nullable=True),
        sa.Column("created_by_user_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["person_id"], ["persons.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["weekly_review_id"], ["time_entry_weekly_reviews.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_person_hours_account_entries_created_by_user_id",
        "person_hours_account_entries",
        ["created_by_user_id"],
    )
    op.create_index(
        "ix_person_hours_account_entries_entry_type",
        "person_hours_account_entries",
        ["entry_type"],
    )
    op.create_index(
        "ix_person_hours_account_entries_person_created",
        "person_hours_account_entries",
        ["person_id", "created_at"],
    )
    op.create_index(
        "ix_person_hours_account_entries_person_id",
        "person_hours_account_entries",
        ["person_id"],
    )
    op.create_index(
        "ix_person_hours_account_entries_week",
        "person_hours_account_entries",
        ["person_id", "iso_year", "iso_week"],
    )
    op.create_index(
        "ix_person_hours_account_entries_weekly_review_id",
        "person_hours_account_entries",
        ["weekly_review_id"],
    )


def downgrade() -> None:
    connection = op.get_bind()
    tables = set(sa.inspect(connection).get_table_names())
    if "person_hours_account_entries" not in tables:
        return
    op.drop_index("ix_person_hours_account_entries_weekly_review_id", table_name="person_hours_account_entries")
    op.drop_index("ix_person_hours_account_entries_week", table_name="person_hours_account_entries")
    op.drop_index("ix_person_hours_account_entries_person_id", table_name="person_hours_account_entries")
    op.drop_index("ix_person_hours_account_entries_person_created", table_name="person_hours_account_entries")
    op.drop_index("ix_person_hours_account_entries_entry_type", table_name="person_hours_account_entries")
    op.drop_index("ix_person_hours_account_entries_created_by_user_id", table_name="person_hours_account_entries")
    op.drop_table("person_hours_account_entries")
