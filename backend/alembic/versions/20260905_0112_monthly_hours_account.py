"""Allow explicitly unknown balances and one active settlement per person/month.

Revision ID: 20260905_0112
Revises: 20260904_0111
"""
from alembic import op
import sqlalchemy as sa

revision = "20260905_0112"
down_revision = "20260904_0111"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # No history, opening balance or existing posting is rewritten.
    with op.batch_alter_table("person_hours_account_entries") as batch:
        batch.alter_column("balance_after_minutes", existing_type=sa.Integer(), nullable=True)
    with op.batch_alter_table("payroll_month_person_snapshots") as batch:
        for name in ("opening_balance_minutes", "movement_minutes", "closing_balance_minutes"):
            batch.alter_column(name, existing_type=sa.Integer(), nullable=True)
    op.create_index(
        "uq_person_hours_account_entries_active_month", "person_hours_account_entries",
        ["person_id", "effective_date"], unique=True,
        sqlite_where=sa.text("entry_type = 'monthly_balance' AND is_active = 1"),
        postgresql_where=sa.text("entry_type = 'monthly_balance' AND is_active = true"),
    )


def downgrade() -> None:
    # Refuse lossy conversion: an unknown balance must never become a fabricated zero.
    connection = op.get_bind()
    if connection.scalar(sa.text("SELECT count(*) FROM person_hours_account_entries WHERE entry_type IN ('monthly_transition', 'monthly_balance', 'monthly_reversal')")):
        raise RuntimeError("Monthly account history prevents a lossless downgrade.")
    for table, columns in (
        ("person_hours_account_entries", ("balance_after_minutes",)),
        ("payroll_month_person_snapshots", ("opening_balance_minutes", "movement_minutes", "closing_balance_minutes")),
    ):
        condition = " OR ".join(f"{name} IS NULL" for name in columns)
        if connection.scalar(sa.text(f"SELECT count(*) FROM {table} WHERE {condition}")):
            raise RuntimeError("Unknown payroll balances prevent a lossless downgrade.")
    op.drop_index("uq_person_hours_account_entries_active_month", table_name="person_hours_account_entries")
    with op.batch_alter_table("person_hours_account_entries") as batch:
        batch.alter_column("balance_after_minutes", existing_type=sa.Integer(), nullable=False)
    with op.batch_alter_table("payroll_month_person_snapshots") as batch:
        for name in ("opening_balance_minutes", "movement_minutes", "closing_balance_minutes"):
            batch.alter_column(name, existing_type=sa.Integer(), nullable=False)
