"""Add structured desktop form fields to extra-work tickets.

Revision ID: 20260819_0098
Revises: 20260818_0097
Create Date: 2026-08-19
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260819_0098"
down_revision: str | None = "20260818_0097"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


FORM_COLUMN_SPECS: tuple[tuple[str, sa.types.TypeEngine], ...] = (
    ("ordered_by_name", sa.String(length=160)),
    ("ordered_by_company", sa.String(length=200)),
    ("billing_type", sa.String(length=32)),
    ("estimated_order_value", sa.Numeric(12, 2)),
    ("material_required", sa.Boolean()),
    ("material_separate_attachment", sa.Boolean()),
    ("executed_by_lead_monteur", sa.Boolean()),
    ("executed_by_monteur", sa.Boolean()),
    ("executed_by_helper", sa.Boolean()),
    ("executor_other_name", sa.String(length=160)),
    ("work_description", sa.Text()),
    ("manual_execution_start", sa.Date()),
    ("manual_execution_end", sa.Date()),
)


def upgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if "extra_work_tickets" not in inspector.get_table_names():
        return
    existing_columns = {
        column["name"] for column in inspector.get_columns("extra_work_tickets")
    }
    for name, column_type in FORM_COLUMN_SPECS:
        if name not in existing_columns:
            op.add_column(
                "extra_work_tickets",
                sa.Column(name, column_type, nullable=True),
            )


def downgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if "extra_work_tickets" not in inspector.get_table_names():
        return
    existing_columns = {
        column["name"] for column in inspector.get_columns("extra_work_tickets")
    }
    for name, _column_type in reversed(FORM_COLUMN_SPECS):
        if name in existing_columns:
            op.drop_column("extra_work_tickets", name)
