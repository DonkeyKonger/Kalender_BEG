"""Index chronological warehouse log pages and date filters."""

from alembic import op

revision = "20260930_0127"
down_revision = "20260930_0126"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index("ix_warehouse_movements_created_id", "warehouse_movements", ["created_at", "id"])


def downgrade() -> None:
    op.drop_index("ix_warehouse_movements_created_id", table_name="warehouse_movements")
