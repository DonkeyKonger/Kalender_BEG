"""Add editable worker signature place and date.

Revision ID: 20260819_0099
Revises: 20260819_0098
Create Date: 2026-08-19
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260819_0099"
down_revision: str | None = "20260819_0098"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


SIGNATURE_COLUMN_SPECS: tuple[tuple[str, sa.types.TypeEngine], ...] = (
    ("worker_signature_place", sa.String(length=160)),
    ("worker_signature_date", sa.Date()),
)


def upgrade() -> None:
    connection = op.get_bind()
    inspector = sa.inspect(connection)
    if "extra_work_tickets" not in inspector.get_table_names():
        return
    existing_columns = {
        column["name"] for column in inspector.get_columns("extra_work_tickets")
    }
    for name, column_type in SIGNATURE_COLUMN_SPECS:
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
    for name, _column_type in reversed(SIGNATURE_COLUMN_SPECS):
        if name in existing_columns:
            op.drop_column("extra_work_tickets", name)
