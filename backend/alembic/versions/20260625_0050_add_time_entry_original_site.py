"""Add original site snapshot for time entries.

Revision ID: 20260625_0050
Revises: 20260623_0049
Create Date: 2026-06-25
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260625_0050"
down_revision: str | None = "20260623_0049"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("work_time_entries", sa.Column("original_site_id", sa.Integer(), nullable=True))
    op.create_foreign_key(
        "fk_work_time_entries_original_site_id_sites",
        "work_time_entries",
        "sites",
        ["original_site_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_work_time_entries_original_site_id", "work_time_entries", ["original_site_id"])
    op.execute("UPDATE work_time_entries SET original_site_id = site_id WHERE original_site_id IS NULL")


def downgrade() -> None:
    op.drop_index("ix_work_time_entries_original_site_id", table_name="work_time_entries")
    op.drop_constraint("fk_work_time_entries_original_site_id_sites", "work_time_entries", type_="foreignkey")
    op.drop_column("work_time_entries", "original_site_id")
