"""Optional internal labels, separate from customer-facing measurement titles."""
from alembic import op
import sqlalchemy as sa

revision = "20260925_0121"
down_revision = "20260924_0120"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("site_measurement_batches", sa.Column("internal_label", sa.String(120), nullable=True))


def downgrade():
    op.drop_column("site_measurement_batches", "internal_label")
