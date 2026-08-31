"""Add immutable realization timestamps.

Revision ID: 20260831_0106
Revises: 20260825_0105
"""
from collections.abc import Sequence
import json

from alembic import op
import sqlalchemy as sa

revision: str = "20260831_0106"
down_revision: str | None = "20260825_0105"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    tables = set(sa.inspect(bind).get_table_names())
    if "site_measurement_batches" in tables:
        columns = {column["name"] for column in sa.inspect(bind).get_columns("site_measurement_batches")}
        if "first_submitted_at" not in columns:
            op.add_column("site_measurement_batches", sa.Column("first_submitted_at", sa.DateTime(timezone=True)))
            op.create_index("ix_site_measurement_batches_first_submitted_at", "site_measurement_batches", ["first_submitted_at"])
        for row in bind.execute(sa.text("SELECT id, submitted_at, original_submitted_snapshot FROM site_measurement_batches WHERE first_submitted_at IS NULL")).mappings():
            snapshot = row["original_submitted_snapshot"]
            if isinstance(snapshot, str):
                try: snapshot = json.loads(snapshot)
                except json.JSONDecodeError: snapshot = None
            value = snapshot.get("submitted_at") if isinstance(snapshot, dict) else None
            value = value or row["submitted_at"]
            if value is not None:
                bind.execute(sa.text("UPDATE site_measurement_batches SET first_submitted_at = :value WHERE id = :id"), {"id": row["id"], "value": value})
    if "extra_work_tickets" in tables:
        columns = {column["name"] for column in sa.inspect(bind).get_columns("extra_work_tickets")}
        if "invoiced_at" not in columns:
            op.add_column("extra_work_tickets", sa.Column("invoiced_at", sa.DateTime(timezone=True)))
            op.create_index("ix_extra_work_tickets_invoiced_at", "extra_work_tickets", ["invoiced_at"])
        # updated_at is not an invoice date; legacy boolean-only markers remain pending.


def downgrade() -> None:
    bind = op.get_bind()
    if "extra_work_tickets" in sa.inspect(bind).get_table_names():
        op.drop_index("ix_extra_work_tickets_invoiced_at", table_name="extra_work_tickets")
        op.drop_column("extra_work_tickets", "invoiced_at")
    if "site_measurement_batches" in sa.inspect(bind).get_table_names():
        op.drop_index("ix_site_measurement_batches_first_submitted_at", table_name="site_measurement_batches")
        op.drop_column("site_measurement_batches", "first_submitted_at")
