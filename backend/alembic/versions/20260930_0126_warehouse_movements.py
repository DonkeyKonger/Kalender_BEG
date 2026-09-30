"""Persist signed warehouse handovers without changing existing inventory."""

from alembic import op
import sqlalchemy as sa

revision = "20260930_0126"
down_revision = "20260930_0125"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "warehouse_movements",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("request_id", sa.String(36), nullable=False, unique=True),
        sa.Column("request_hash", sa.String(64), nullable=False),
        sa.Column("direction", sa.String(10), nullable=False),
        sa.Column("employee_id_snapshot", sa.Integer(), nullable=False),
        sa.Column("employee_name", sa.String(200), nullable=False),
        sa.Column("actor_user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("actor_name", sa.String(200), nullable=False),
        sa.Column("items", sa.JSON(), nullable=False),
        sa.Column("signature_strokes", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("direction IN ('issue', 'return')", name="ck_warehouse_movement_direction"),
    )
    op.create_index("ix_warehouse_movements_employee_id_snapshot", "warehouse_movements", ["employee_id_snapshot"])


def downgrade() -> None:
    op.drop_table("warehouse_movements")
