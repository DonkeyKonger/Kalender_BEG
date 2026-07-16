"""Separate blank office measurements from offer-based measurements.

Revision ID: 20260716_0086
Revises: 20260716_0085
Create Date: 2026-07-16
"""

from collections.abc import Sequence
import logging

from alembic import op
import sqlalchemy as sa
from sqlalchemy.engine import Connection


revision: str = "20260716_0086"
down_revision: str | None = "20260716_0085"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None
LOGGER = logging.getLogger(__name__)


def _convert_safe_empty_office_batches(connection: Connection) -> list[int]:
    safe_office_batch_ids = sa.text(
        """
        SELECT batch.id
        FROM site_measurement_batches AS batch
        WHERE batch.origin = 'OFFICE'
          AND batch.status = 'draft'
          AND batch.submitted_at IS NULL
          AND batch.original_submitted_snapshot IS NULL
          AND batch.customer_signed_at IS NULL
          AND batch.customer_signed_snapshot IS NULL
          AND batch.worker_signed_at IS NULL
          AND NOT EXISTS (
              SELECT 1 FROM site_measurement_entries AS entry
              WHERE entry.measurement_batch_id = batch.id
          )
          AND NOT EXISTS (
              SELECT 1 FROM site_measurement_items AS item
              WHERE item.measurement_batch_id = batch.id
          )
        """
    )
    safe_ids = [row[0] for row in connection.execute(safe_office_batch_ids)]
    if not safe_ids:
        return []
    batch_ids = sa.bindparam("batch_ids", expanding=True)
    connection.execute(
        sa.text(
            "DELETE FROM site_measurement_area_rows "
            "WHERE measurement_batch_id IN :batch_ids"
        ).bindparams(batch_ids),
        {"batch_ids": safe_ids},
    )
    connection.execute(
        sa.text(
            "UPDATE site_measurement_batches "
            "SET position_mode = 'BLANK', measurement_base_id = NULL "
            "WHERE id IN :batch_ids"
        ).bindparams(batch_ids),
        {"batch_ids": safe_ids},
    )
    return safe_ids


def upgrade() -> None:
    op.add_column(
        "site_measurement_batches",
        sa.Column(
            "position_mode",
            sa.String(length=20),
            nullable=False,
            server_default="OFFER_BASED",
        ),
    )
    op.create_check_constraint(
        "measurement_batch_position_mode",
        "site_measurement_batches",
        "position_mode IN ('OFFER_BASED', 'BLANK')",
    )
    op.create_index(
        "ix_site_measurement_batches_position_mode",
        "site_measurement_batches",
        ["position_mode"],
    )

    with op.batch_alter_table("site_measurement_batches") as batch_op:
        batch_op.alter_column(
            "measurement_base_id",
            existing_type=sa.Integer(),
            nullable=True,
        )
    with op.batch_alter_table("site_measurement_items") as batch_op:
        batch_op.alter_column(
            "measurement_base_id",
            existing_type=sa.Integer(),
            nullable=True,
        )

    connection = op.get_bind()
    safe_ids = _convert_safe_empty_office_batches(connection)
    if safe_ids:
        LOGGER.info("Converted %s empty office measurement batches to BLANK.", len(safe_ids))

    unsafe_office_count = connection.scalar(
        sa.text(
            "SELECT COUNT(*) FROM site_measurement_batches "
            "WHERE origin = 'OFFICE' AND position_mode <> 'BLANK'"
        )
    )
    if unsafe_office_count:
        LOGGER.warning(
            "Left %s non-empty or completed office measurement batches unchanged for manual review.",
            unsafe_office_count,
        )


def downgrade() -> None:
    connection = op.get_bind()
    blank_count = connection.scalar(
        sa.text(
            "SELECT COUNT(*) FROM site_measurement_batches "
            "WHERE measurement_base_id IS NULL OR position_mode = 'BLANK'"
        )
    )
    if blank_count:
        raise RuntimeError(
            "Downgrade nicht möglich, solange Blanko-Aufmaße ohne Angebotsgrundlage bestehen."
        )
    with op.batch_alter_table("site_measurement_items") as batch_op:
        batch_op.alter_column(
            "measurement_base_id",
            existing_type=sa.Integer(),
            nullable=False,
        )
    with op.batch_alter_table("site_measurement_batches") as batch_op:
        batch_op.alter_column(
            "measurement_base_id",
            existing_type=sa.Integer(),
            nullable=False,
        )
    op.drop_index(
        "ix_site_measurement_batches_position_mode",
        table_name="site_measurement_batches",
    )
    op.drop_constraint(
        "measurement_batch_position_mode",
        "site_measurement_batches",
        type_="check",
    )
    op.drop_column("site_measurement_batches", "position_mode")
