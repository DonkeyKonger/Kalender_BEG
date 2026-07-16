"""Remove empty placeholder items from blank measurements.

Revision ID: 20260716_0087
Revises: 20260716_0086
Create Date: 2026-07-16
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa
from sqlalchemy.engine import Connection


revision: str = "20260716_0087"
down_revision: str | None = "20260716_0086"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _remove_empty_placeholder_items(connection: Connection) -> int:
    result = connection.execute(
        sa.text(
            """
            DELETE FROM site_measurement_items
            WHERE id IN (
                SELECT item.id
                FROM site_measurement_items AS item
                JOIN site_measurement_batches AS batch
                  ON batch.id = item.measurement_batch_id
                WHERE batch.position_mode = 'BLANK'
                  AND item.is_free_position = TRUE
                  AND TRIM(item.description) = ''
                  AND UPPER(item.position) LIKE 'FREI-%'
                  AND (item.unit IS NULL OR LOWER(TRIM(item.unit)) IN ('', 'st'))
                  AND NOT EXISTS (
                      SELECT 1
                      FROM site_measurement_entries AS entry
                      WHERE entry.measurement_item_id = item.id
                  )
            )
            """
        )
    )
    return max(result.rowcount or 0, 0)


def upgrade() -> None:
    _remove_empty_placeholder_items(op.get_bind())


def downgrade() -> None:
    # Removed rows carried no user-entered position data and are intentionally not recreated.
    pass
