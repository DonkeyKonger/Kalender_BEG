"""Keep office corrections to shared catalog positions local to one measurement."""
from alembic import op
import sqlalchemy as sa

revision = "20260914_0118"
down_revision = "20260913_0117"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("site_measurement_batches", sa.Column("item_overrides", sa.JSON(), nullable=False, server_default="{}"))


def downgrade():
    op.drop_column("site_measurement_batches", "item_overrides")
