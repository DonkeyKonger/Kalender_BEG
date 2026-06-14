"""Add time entry weekly reviews.

Revision ID: 20260614_0039
Revises: 20260612_0038
Create Date: 2026-06-14
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260614_0039"
down_revision: str | None = "20260612_0038"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "time_entry_weekly_reviews",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("person_id", sa.Integer(), nullable=False),
        sa.Column("iso_year", sa.Integer(), nullable=False),
        sa.Column("iso_week", sa.Integer(), nullable=False),
        sa.Column("reviewed_by_user_id", sa.Integer(), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["person_id"], ["persons.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["reviewed_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("person_id", "iso_year", "iso_week", name="uq_time_entry_weekly_reviews_person_week"),
    )
    op.create_index("ix_time_entry_weekly_reviews_person_id", "time_entry_weekly_reviews", ["person_id"])
    op.create_index("ix_time_entry_weekly_reviews_reviewed_by_user_id", "time_entry_weekly_reviews", ["reviewed_by_user_id"])
    op.create_index("ix_time_entry_weekly_reviews_week", "time_entry_weekly_reviews", ["iso_year", "iso_week"])


def downgrade() -> None:
    op.drop_index("ix_time_entry_weekly_reviews_week", table_name="time_entry_weekly_reviews")
    op.drop_index("ix_time_entry_weekly_reviews_reviewed_by_user_id", table_name="time_entry_weekly_reviews")
    op.drop_index("ix_time_entry_weekly_reviews_person_id", table_name="time_entry_weekly_reviews")
    op.drop_table("time_entry_weekly_reviews")
