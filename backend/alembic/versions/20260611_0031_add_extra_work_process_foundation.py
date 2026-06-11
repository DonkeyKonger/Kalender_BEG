"""Add extra work process foundation.

Revision ID: 20260611_0031
Revises: 20260611_0030
Create Date: 2026-06-11
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260611_0031"
down_revision: str | None = "20260611_0030"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "extra_work_tickets",
        sa.Column("kind", sa.String(length=40), nullable=False, server_default="billing"),
    )
    op.add_column(
        "extra_work_tickets",
        sa.Column("approval_ticket_id", sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        "fk_extra_work_tickets_approval_ticket_id",
        "extra_work_tickets",
        "extra_work_tickets",
        ["approval_ticket_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_extra_work_tickets_kind", "extra_work_tickets", ["kind"])
    op.create_index("ix_extra_work_tickets_approval_ticket_id", "extra_work_tickets", ["approval_ticket_id"])

    op.add_column(
        "sites",
        sa.Column("requires_extra_work_approval", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("sites", "requires_extra_work_approval")
    op.drop_index("ix_extra_work_tickets_approval_ticket_id", table_name="extra_work_tickets")
    op.drop_index("ix_extra_work_tickets_kind", table_name="extra_work_tickets")
    op.drop_constraint("fk_extra_work_tickets_approval_ticket_id", "extra_work_tickets", type_="foreignkey")
    op.drop_column("extra_work_tickets", "approval_ticket_id")
    op.drop_column("extra_work_tickets", "kind")
