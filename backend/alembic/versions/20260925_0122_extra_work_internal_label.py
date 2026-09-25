"""Internal extra-work labels, independent of customer-facing document titles."""
from alembic import op
import sqlalchemy as sa

revision = "20260925_0122"
down_revision = "20260925_0121"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("extra_work_tickets", sa.Column("internal_label", sa.String(120), nullable=True))


def downgrade():
    op.drop_column("extra_work_tickets", "internal_label")
