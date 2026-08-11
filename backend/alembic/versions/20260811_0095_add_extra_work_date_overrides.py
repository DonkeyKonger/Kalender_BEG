"""Add optional document-date overrides to extra-work tickets.

Revision ID: 20260811_0095
Revises: 20260811_0094
Create Date: 2026-08-11
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260811_0095"
down_revision: str | None = "20260811_0094"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    connection = op.get_bind()
    columns = {column["name"] for column in sa.inspect(connection).get_columns("extra_work_tickets")}
    if "manual_order_date" not in columns:
        op.add_column("extra_work_tickets", sa.Column("manual_order_date", sa.Date(), nullable=True))
    if "manual_execution_week" not in columns:
        op.add_column("extra_work_tickets", sa.Column("manual_execution_week", sa.Integer(), nullable=True))
    if "manual_execution_week_year" not in columns:
        op.add_column(
            "extra_work_tickets",
            sa.Column("manual_execution_week_year", sa.Integer(), nullable=True),
        )
    check_constraints = {
        constraint["name"]
        for constraint in sa.inspect(connection).get_check_constraints("extra_work_tickets")
    }
    if "ck_extra_work_ticket_manual_execution_week_pair" not in check_constraints:
        op.create_check_constraint(
            "ck_extra_work_ticket_manual_execution_week_pair",
            "extra_work_tickets",
            "(manual_execution_week IS NULL AND manual_execution_week_year IS NULL) OR "
            "(manual_execution_week IS NOT NULL AND manual_execution_week_year IS NOT NULL)",
        )
    if "ck_extra_work_ticket_manual_execution_week_range" not in check_constraints:
        op.create_check_constraint(
            "ck_extra_work_ticket_manual_execution_week_range",
            "extra_work_tickets",
            "manual_execution_week IS NULL OR manual_execution_week BETWEEN 1 AND 53",
        )


def downgrade() -> None:
    op.drop_constraint(
        "ck_extra_work_ticket_manual_execution_week_range",
        "extra_work_tickets",
        type_="check",
    )
    op.drop_constraint(
        "ck_extra_work_ticket_manual_execution_week_pair",
        "extra_work_tickets",
        type_="check",
    )
    op.drop_column("extra_work_tickets", "manual_execution_week_year")
    op.drop_column("extra_work_tickets", "manual_execution_week")
    op.drop_column("extra_work_tickets", "manual_order_date")
