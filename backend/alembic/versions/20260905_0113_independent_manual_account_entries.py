"""Permit new independent manual account entries, not locked payroll mutations.

Revision ID: 20260905_0113
Revises: 20260905_0112
"""
from alembic import op

revision = "20260905_0113"
down_revision = "20260905_0112"
branch_labels = None
depends_on = None

MANUAL_INSERT_RULE = """
          IF TG_OP = 'INSERT'
             AND NEW.ledger_system = 'daily'
             AND NEW.entry_type IN ('manual_adjustment', 'payout')
             AND NEW.source_type = NEW.entry_type
             AND NEW.source_reference_id IS NULL
             AND NEW.weekly_review_id IS NULL
             AND NEW.is_active IS TRUE THEN
            -- Same account lock as capture/month approval; deliberately no
            -- payroll-period lock for this independent append-only movement.
            PERFORM 1 FROM persons WHERE id = NEW.person_id FOR UPDATE;
            RETURN NEW;
          END IF;
"""


def guard_sql(*, allow_manual_insert: bool) -> str:
    return """
        CREATE OR REPLACE FUNCTION payroll_guard_hours_account_row()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
        """ + (MANUAL_INSERT_RULE if allow_manual_insert else "") + """
          IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.effective_date IS NOT NULL THEN
            PERFORM payroll_assert_month_open(OLD.effective_date);
            PERFORM payroll_assert_person_month_open(OLD.person_id, OLD.effective_date);
          END IF;
          IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.effective_date IS NOT NULL THEN
            PERFORM payroll_assert_month_open(NEW.effective_date);
            PERFORM payroll_assert_person_month_open(NEW.person_id, NEW.effective_date);
          END IF;
          RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
        END
        $$
        """


def upgrade() -> None:
    if op.get_bind().dialect.name == "postgresql":
        op.execute(guard_sql(allow_manual_insert=True))


def downgrade() -> None:
    if op.get_bind().dialect.name == "postgresql":
        op.execute(guard_sql(allow_manual_insert=False))
