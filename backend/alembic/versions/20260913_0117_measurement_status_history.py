"""Record actual measurement status transitions without guessing legacy history."""
from alembic import op
import sqlalchemy as sa

revision = "20260913_0117"
down_revision = "20260911_0116"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("site_measurement_batches", sa.Column("status_history", sa.JSON(), nullable=False, server_default="[]"))


def downgrade():
    op.drop_column("site_measurement_batches", "status_history")
