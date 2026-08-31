"""Backfill auditable extra-work invoice timestamps.

Revision ID: 20260831_0107
Revises: 20260831_0106
"""
from collections.abc import Sequence
import json

from alembic import op
import sqlalchemy as sa


revision: str = "20260831_0107"
down_revision: str | None = "20260831_0106"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _is_invoiced_update(value: object) -> bool:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return False
    return isinstance(value, dict) and value.get("is_invoiced") is True


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())
    if {"extra_work_tickets", "audit_logs"} - tables:
        return

    ticket_columns = {
        column["name"]
        for column in inspector.get_columns("extra_work_tickets")
    }
    if not {"is_invoiced", "invoiced_at"} <= ticket_columns:
        return

    ticket_ids = [
        row["id"]
        for row in bind.execute(
            sa.text(
                "SELECT id FROM extra_work_tickets "
                "WHERE is_invoiced = true AND invoiced_at IS NULL"
            )
        ).mappings()
    ]
    if not ticket_ids:
        return

    statement = sa.text(
        "SELECT entity_id, created_at, new_value_json "
        "FROM audit_logs "
        "WHERE action = 'extra_work.invoiced_updated' "
        "AND entity_type = 'extra_work_ticket' "
        "AND entity_id IN :ticket_ids "
        "ORDER BY entity_id, created_at, id"
    ).bindparams(sa.bindparam("ticket_ids", expanding=True))
    first_invoiced_at: dict[int, object] = {}
    for row in bind.execute(statement, {"ticket_ids": ticket_ids}).mappings():
        ticket_id = row["entity_id"]
        if ticket_id not in first_invoiced_at and _is_invoiced_update(
            row["new_value_json"]
        ):
            first_invoiced_at[ticket_id] = row["created_at"]

    for ticket_id, invoiced_at in first_invoiced_at.items():
        bind.execute(
            sa.text(
                "UPDATE extra_work_tickets "
                "SET invoiced_at = :invoiced_at "
                "WHERE id = :ticket_id AND invoiced_at IS NULL"
            ),
            {"ticket_id": ticket_id, "invoiced_at": invoiced_at},
        )


def downgrade() -> None:
    # The timestamp is an immutable accounting fact and must not be erased.
    pass
