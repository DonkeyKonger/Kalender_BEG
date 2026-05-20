"""Add matrix cell marks.

Revision ID: 20260520_0003
Revises: 20260520_0002
Create Date: 2026-05-20
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260520_0003"
down_revision: str | None = "20260520_0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

matrix_cell_mark = postgresql.ENUM("orange", "red", "blue", name="matrix_cell_mark", create_type=False)


def upgrade() -> None:
    matrix_cell_mark.create(op.get_bind(), checkfirst=True)
    op.create_table(
        "planning_cell_marks",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("site_id", sa.Integer(), nullable=False),
        sa.Column("mark_date", sa.Date(), nullable=False),
        sa.Column("mark", matrix_cell_mark, nullable=False),
        sa.Column("created_by_user_id", sa.Integer(), nullable=True),
        sa.Column("updated_by_user_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["site_id"], ["sites.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["updated_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("site_id", "mark_date", name="uq_planning_cell_marks_site_date"),
    )
    op.create_index("ix_planning_cell_marks_site_date", "planning_cell_marks", ["site_id", "mark_date"])


def downgrade() -> None:
    op.drop_index("ix_planning_cell_marks_site_date", table_name="planning_cell_marks")
    op.drop_table("planning_cell_marks")
    matrix_cell_mark.drop(op.get_bind(), checkfirst=True)
