"""Track office review separately from immutable warehouse receipt contents."""

from alembic import op
import sqlalchemy as sa

revision = "20261005_0128"
down_revision = "20260930_0127"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("warehouse_movements", sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("warehouse_movements", sa.Column("reviewed_by_user_id", sa.Integer(), nullable=True))
    op.add_column("warehouse_movements", sa.Column("reviewed_by_name", sa.String(200), nullable=True))
    op.add_column("warehouse_movements", sa.Column("review_version", sa.Integer(), server_default="0", nullable=False))
    op.create_foreign_key("fk_warehouse_reviewed_by", "warehouse_movements", "users", ["reviewed_by_user_id"], ["id"], ondelete="SET NULL")


def downgrade() -> None:
    op.drop_constraint("fk_warehouse_reviewed_by", "warehouse_movements", type_="foreignkey")
    for column in ("review_version", "reviewed_by_name", "reviewed_by_user_id", "reviewed_at"):
        op.drop_column("warehouse_movements", column)
