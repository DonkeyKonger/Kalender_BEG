"""Store explicit employment dates without inferring dates for existing people."""

import sqlalchemy as sa
from alembic import op

revision = "20261102_0131"
down_revision = "20261009_0130"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("persons") as batch:
        batch.add_column(sa.Column("employment_start_date", sa.Date(), nullable=True))
        batch.add_column(sa.Column("employment_end_date", sa.Date(), nullable=True))
        batch.create_check_constraint(
            "ck_persons_employment_dates",
            "employment_end_date IS NULL OR employment_start_date IS NULL "
            "OR employment_end_date >= employment_start_date",
        )


def downgrade() -> None:
    with op.batch_alter_table("persons") as batch:
        batch.drop_constraint("ck_persons_employment_dates", type_="check")
        batch.drop_column("employment_end_date")
        batch.drop_column("employment_start_date")
