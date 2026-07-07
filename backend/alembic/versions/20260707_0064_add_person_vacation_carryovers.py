"""Add person vacation carryovers.

Revision ID: 20260707_0064
Revises: 20260707_0063
Create Date: 2026-07-07
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260707_0064"
down_revision: str | None = "20260707_0063"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    connection = op.get_bind()
    tables = set(sa.inspect(connection).get_table_names())
    if "person_vacation_carryovers" in tables:
        return
    op.create_table(
        "person_vacation_carryovers",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("person_id", sa.Integer(), nullable=False),
        sa.Column("year", sa.Integer(), nullable=False),
        sa.Column("carryover_days", sa.Integer(), nullable=False),
        sa.Column("created_by_user_id", sa.Integer(), nullable=True),
        sa.Column("updated_by_user_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["person_id"], ["persons.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["updated_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("person_id", "year", name="uq_person_vacation_carryovers_person_year"),
    )
    op.create_index(
        "ix_person_vacation_carryovers_created_by_user_id",
        "person_vacation_carryovers",
        ["created_by_user_id"],
    )
    op.create_index(
        "ix_person_vacation_carryovers_person_id",
        "person_vacation_carryovers",
        ["person_id"],
    )
    op.create_index(
        "ix_person_vacation_carryovers_updated_by_user_id",
        "person_vacation_carryovers",
        ["updated_by_user_id"],
    )
    op.create_index(
        "ix_person_vacation_carryovers_year",
        "person_vacation_carryovers",
        ["year"],
    )


def downgrade() -> None:
    connection = op.get_bind()
    tables = set(sa.inspect(connection).get_table_names())
    if "person_vacation_carryovers" not in tables:
        return
    op.drop_index("ix_person_vacation_carryovers_year", table_name="person_vacation_carryovers")
    op.drop_index("ix_person_vacation_carryovers_updated_by_user_id", table_name="person_vacation_carryovers")
    op.drop_index("ix_person_vacation_carryovers_person_id", table_name="person_vacation_carryovers")
    op.drop_index("ix_person_vacation_carryovers_created_by_user_id", table_name="person_vacation_carryovers")
    op.drop_table("person_vacation_carryovers")
