"""Add evidenced document workflow dates.

Revision ID: 20261116_0133
Revises: 20261116_0132
"""

from collections.abc import Sequence
from datetime import UTC, datetime
import json

from alembic import op
import sqlalchemy as sa


revision: str = "20261116_0133"
down_revision: str | None = "20261116_0132"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


REVIEWED_OR_COMPLETED_STATUSES = {
    "reviewed",
    "checked",
    "billed",
    "approved",
    "closed",
    "completed",
    "finalized",
    "abgeschlossen",
}


def _mapping(value: object) -> dict[str, object] | None:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return None
    return value if isinstance(value, dict) else None


def _timestamp(value: object) -> datetime | None:
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    else:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _earliest(*values: object) -> datetime | None:
    parsed = [candidate for value in values if (candidate := _timestamp(value))]
    return min(parsed) if parsed else None


def _history_event_at(value: object) -> datetime | None:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return None
    if not isinstance(value, list):
        return None
    candidates = []
    for event in value:
        if not isinstance(event, dict) or event.get("kind") != "advance":
            continue
        target = str(event.get("to") or "").strip().lower()
        if target in REVIEWED_OR_COMPLETED_STATUSES:
            candidates.append(event.get("at"))
    return _earliest(*candidates)


def _audit_is_qualifying(action: str, value: object) -> bool:
    payload = _mapping(value)
    if payload is None:
        return False
    target = str(payload.get("status") or "").strip().lower()
    if target in REVIEWED_OR_COMPLETED_STATUSES:
        return True
    return action.endswith(".invoiced_updated") and payload.get("is_invoiced") is True


def _audit_event_dates(
    bind,
    *,
    entity_type: str,
    entity_ids: list[int],
    actions: tuple[str, ...],
) -> dict[int, datetime]:
    if not entity_ids or "audit_logs" not in sa.inspect(bind).get_table_names():
        return {}
    statement = sa.text(
        "SELECT entity_id, action, new_value_json, created_at "
        "FROM audit_logs "
        "WHERE entity_type = :entity_type "
        "AND entity_id IN :entity_ids "
        "AND action IN :actions "
        "ORDER BY entity_id, created_at, id"
    ).bindparams(
        sa.bindparam("entity_ids", expanding=True),
        sa.bindparam("actions", expanding=True),
    )
    result: dict[int, datetime] = {}
    for row in bind.execute(
        statement,
        {
            "entity_type": entity_type,
            "entity_ids": entity_ids,
            "actions": actions,
        },
    ).mappings():
        entity_id = row["entity_id"]
        if entity_id in result or not _audit_is_qualifying(
            row["action"], row["new_value_json"]
        ):
            continue
        event_at = _timestamp(row["created_at"])
        if event_at is not None:
            result[entity_id] = event_at
    return result


def _add_columns(bind) -> None:
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())
    if "site_measurement_batches" in tables:
        columns = {
            column["name"]
            for column in inspector.get_columns("site_measurement_batches")
        }
        if "first_worker_submitted_at" not in columns:
            op.add_column(
                "site_measurement_batches",
                sa.Column(
                    "first_worker_submitted_at",
                    sa.DateTime(timezone=True),
                    nullable=True,
                ),
            )
        if "first_reviewed_or_completed_at" not in columns:
            op.add_column(
                "site_measurement_batches",
                sa.Column(
                    "first_reviewed_or_completed_at",
                    sa.DateTime(timezone=True),
                    nullable=True,
                ),
            )
    if "extra_work_tickets" in tables:
        columns = {
            column["name"] for column in inspector.get_columns("extra_work_tickets")
        }
        if "first_submitted_at" not in columns:
            op.add_column(
                "extra_work_tickets",
                sa.Column("first_submitted_at", sa.DateTime(timezone=True)),
            )
        if "first_reviewed_or_completed_at" not in columns:
            op.add_column(
                "extra_work_tickets",
                sa.Column(
                    "first_reviewed_or_completed_at",
                    sa.DateTime(timezone=True),
                ),
            )


def _backfill_measurements(bind) -> None:
    inspector = sa.inspect(bind)
    if "site_measurement_batches" not in inspector.get_table_names():
        return
    columns = {
        column["name"]
        for column in inspector.get_columns("site_measurement_batches")
    }
    required = {
        "id",
        "origin",
        "submitted_by_user_id",
        "submitted_at",
        "first_submitted_at",
        "first_worker_submitted_at",
        "original_submitted_snapshot",
        "status_history",
        "first_reviewed_or_completed_at",
    }
    if not required <= columns:
        return
    rows = list(
        bind.execute(
            sa.text(
                "SELECT id, origin, submitted_by_user_id, submitted_at, "
                "first_submitted_at, first_worker_submitted_at, "
                "original_submitted_snapshot, status_history, "
                "first_reviewed_or_completed_at FROM site_measurement_batches"
            )
        ).mappings()
    )
    audit_dates = _audit_event_dates(
        bind,
        entity_type="site_measurement_batch",
        entity_ids=[row["id"] for row in rows],
        actions=("measurement.status_promoted", "measurement.invoiced_updated"),
    )
    for row in rows:
        values: dict[str, datetime | None] = {}
        snapshot = _mapping(row["original_submitted_snapshot"])
        snapshot_at = _timestamp(snapshot.get("submitted_at")) if snapshot else None
        submitted_at = None
        if str(row["origin"] or "").upper() != "OFFICE":
            submitted_at = _timestamp(row["submitted_at"])
        if row["first_worker_submitted_at"] is None:
            legacy_first_submission = _timestamp(row["first_submitted_at"])
            if snapshot_at is not None:
                evidenced_first_submission = snapshot_at
            elif submitted_at is not None:
                evidenced_first_submission = (
                    legacy_first_submission
                    if legacy_first_submission is not None
                    and legacy_first_submission <= submitted_at
                    else submitted_at
                )
            else:
                evidenced_first_submission = None
            if evidenced_first_submission is not None:
                # Keep the legacy first_submitted_at untouched because existing
                # combined-document hashes include it. The new column carries
                # only the independently validated worker event.
                values["first_worker_submitted_at"] = evidenced_first_submission
        if row["first_reviewed_or_completed_at"] is None:
            event_at = _earliest(
                _history_event_at(row["status_history"]),
                audit_dates.get(row["id"]),
            )
            if event_at is not None:
                values["first_reviewed_or_completed_at"] = event_at
        if values:
            assignments = ", ".join(f"{name} = :{name}" for name in values)
            bind.execute(
                sa.text(
                    f"UPDATE site_measurement_batches SET {assignments} WHERE id = :id"
                ),
                {"id": row["id"], **values},
            )


def _backfill_extra_work(bind) -> None:
    inspector = sa.inspect(bind)
    if "extra_work_tickets" not in inspector.get_table_names():
        return
    columns = {
        column["name"] for column in inspector.get_columns("extra_work_tickets")
    }
    required = {
        "id",
        "submitted_by_user_id",
        "submitted_at",
        "first_submitted_at",
        "invoiced_at",
        "first_reviewed_or_completed_at",
    }
    if not required <= columns:
        return
    rows = list(
        bind.execute(
            sa.text(
                "SELECT id, submitted_by_user_id, submitted_at, first_submitted_at, "
                "invoiced_at, first_reviewed_or_completed_at FROM extra_work_tickets"
            )
        ).mappings()
    )
    audit_dates = _audit_event_dates(
        bind,
        entity_type="extra_work_ticket",
        entity_ids=[row["id"] for row in rows],
        actions=("extra_work.status_promoted", "extra_work.invoiced_updated"),
    )
    for row in rows:
        values: dict[str, datetime] = {}
        if (
            row["first_submitted_at"] is None
            and (submitted_at := _timestamp(row["submitted_at"])) is not None
        ):
            values["first_submitted_at"] = submitted_at
        if row["first_reviewed_or_completed_at"] is None:
            event_at = _earliest(
                row["invoiced_at"],
                audit_dates.get(row["id"]),
            )
            if event_at is not None:
                values["first_reviewed_or_completed_at"] = event_at
        if values:
            assignments = ", ".join(f"{name} = :{name}" for name in values)
            bind.execute(
                sa.text(
                    f"UPDATE extra_work_tickets SET {assignments} WHERE id = :id"
                ),
                {"id": row["id"], **values},
            )


def upgrade() -> None:
    bind = op.get_bind()
    _add_columns(bind)
    _backfill_measurements(bind)
    _backfill_extra_work(bind)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())
    if "extra_work_tickets" in tables:
        columns = {
            column["name"] for column in inspector.get_columns("extra_work_tickets")
        }
        if "first_reviewed_or_completed_at" in columns:
            op.drop_column("extra_work_tickets", "first_reviewed_or_completed_at")
        if "first_submitted_at" in columns:
            op.drop_column("extra_work_tickets", "first_submitted_at")
    if "site_measurement_batches" in tables:
        columns = {
            column["name"]
            for column in inspector.get_columns("site_measurement_batches")
        }
        if "first_reviewed_or_completed_at" in columns:
            op.drop_column(
                "site_measurement_batches", "first_reviewed_or_completed_at"
            )
        if "first_worker_submitted_at" in columns:
            op.drop_column(
                "site_measurement_batches", "first_worker_submitted_at"
            )
