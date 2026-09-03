"""Enforce payroll locks and append-only snapshots in PostgreSQL.

Revision ID: 20260903_0110
Revises: 20260903_0109
Create Date: 2026-09-03
"""

from collections.abc import Sequence

from alembic import op


revision: str = "20260903_0110"
down_revision: str | None = "20260903_0109"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    connection = op.get_bind()
    if connection.dialect.name != "postgresql":
        return

    op.execute(
        """
        CREATE OR REPLACE FUNCTION payroll_month_advisory_key(p_year integer, p_month integer)
        RETURNS bigint
        LANGUAGE sql IMMUTABLE STRICT
        AS $$ SELECT 344693735424::bigint + p_year::bigint * 100 + p_month::bigint $$
        """
    )
    op.execute(
        """
        CREATE OR REPLACE FUNCTION payroll_assert_month_open(p_date date)
        RETURNS void
        LANGUAGE plpgsql
        AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(
            payroll_month_advisory_key(EXTRACT(YEAR FROM p_date)::integer,
                                       EXTRACT(MONTH FROM p_date)::integer)
          );
          IF EXISTS (
            SELECT 1 FROM payroll_month_periods p
             WHERE p.year = EXTRACT(YEAR FROM p_date)::integer
               AND p.month = EXTRACT(MONTH FROM p_date)::integer
               AND p.status = 'LOCKED'
          ) THEN
            RAISE EXCEPTION 'payroll_month_locked: %', to_char(p_date, 'YYYY-MM')
              USING ERRCODE = 'P0001';
          END IF;
        END
        $$
        """
    )
    op.execute(
        """
        CREATE OR REPLACE FUNCTION payroll_assert_range_open(p_start date, p_end date)
        RETURNS void
        LANGUAGE plpgsql
        AS $$
        DECLARE cursor_month date;
        BEGIN
          cursor_month := date_trunc('month', p_start)::date;
          WHILE cursor_month <= date_trunc('month', p_end)::date LOOP
            PERFORM payroll_assert_month_open(cursor_month);
            cursor_month := (cursor_month + interval '1 month')::date;
          END LOOP;
        END
        $$
        """
    )
    op.execute(
        """
        CREATE OR REPLACE FUNCTION payroll_guard_dated_row()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF TG_OP IN ('UPDATE', 'DELETE') THEN
            PERFORM payroll_assert_month_open(OLD.work_date);
          END IF;
          IF TG_OP IN ('INSERT', 'UPDATE') THEN
            PERFORM payroll_assert_month_open(NEW.work_date);
          END IF;
          RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
        END
        $$
        """
    )
    for table in ("work_time_entries", "person_work_days"):
        op.execute(
            f"""
            CREATE TRIGGER trg_{table}_payroll_month_open
            BEFORE INSERT OR UPDATE OR DELETE ON {table}
            FOR EACH ROW EXECUTE FUNCTION payroll_guard_dated_row()
            """
        )

    op.execute(
        """
        CREATE OR REPLACE FUNCTION payroll_guard_absence_row()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF TG_OP IN ('UPDATE', 'DELETE') THEN
            PERFORM payroll_assert_range_open(OLD.start_date, OLD.end_date);
          END IF;
          IF TG_OP IN ('INSERT', 'UPDATE') THEN
            PERFORM payroll_assert_range_open(NEW.start_date, NEW.end_date);
          END IF;
          RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
        END
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER trg_absences_payroll_month_open
        BEFORE INSERT OR UPDATE OR DELETE ON absences
        FOR EACH ROW EXECUTE FUNCTION payroll_guard_absence_row()
        """
    )

    op.execute(
        """
        CREATE OR REPLACE FUNCTION payroll_guard_hours_account_row()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.effective_date IS NOT NULL THEN
            PERFORM payroll_assert_month_open(OLD.effective_date);
          END IF;
          IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.effective_date IS NOT NULL THEN
            PERFORM payroll_assert_month_open(NEW.effective_date);
          END IF;
          RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
        END
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER trg_person_hours_account_entries_payroll_month_open
        BEFORE INSERT OR UPDATE OR DELETE ON person_hours_account_entries
        FOR EACH ROW EXECUTE FUNCTION payroll_guard_hours_account_row()
        """
    )

    op.execute(
        """
        CREATE OR REPLACE FUNCTION payroll_guard_schedule_row()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        DECLARE range_start date; range_end date;
        BEGIN
          -- Shared by close and schedule/opening-balance administration.
          PERFORM pg_advisory_xact_lock(5259609);
          IF TG_OP IN ('INSERT', 'UPDATE') AND EXISTS (
            SELECT 1
              FROM person_weekly_schedules other
             WHERE other.person_id = NEW.person_id
               AND (TG_OP = 'INSERT' OR other.id <> NEW.id)
               AND daterange(
                     other.valid_from,
                     COALESCE(other.valid_until, 'infinity'::date),
                     '[]'
                   ) && daterange(
                     NEW.valid_from,
                     COALESCE(NEW.valid_until, 'infinity'::date),
                     '[]'
                   )
          ) THEN
            RAISE EXCEPTION 'weekly schedule validity ranges overlap for person %', NEW.person_id
              USING ERRCODE = '23P01';
          END IF;
          IF TG_OP = 'DELETE' THEN
            range_start := OLD.valid_from;
            range_end := COALESCE(OLD.valid_until, '9999-12-31'::date);
            IF EXISTS (
              SELECT 1 FROM payroll_month_periods p
               WHERE p.status = 'LOCKED'
                 AND make_date(p.year, p.month, 1) <= range_end
                 AND (make_date(p.year, p.month, 1) + interval '1 month - 1 day')::date >= range_start
            ) THEN
              RAISE EXCEPTION 'payroll_month_locked: weekly schedule overlaps a locked month'
                USING ERRCODE = 'P0001';
            END IF;
          END IF;
          IF TG_OP = 'INSERT' THEN
            range_start := NEW.valid_from;
            range_end := COALESCE(NEW.valid_until, '9999-12-31'::date);
            IF EXISTS (
              SELECT 1 FROM payroll_month_periods p
               WHERE p.status = 'LOCKED'
                 AND make_date(p.year, p.month, 1) <= range_end
                 AND (make_date(p.year, p.month, 1) + interval '1 month - 1 day')::date >= range_start
            ) THEN
              RAISE EXCEPTION 'payroll_month_locked: weekly schedule overlaps a locked month'
                USING ERRCODE = 'P0001';
            END IF;
          END IF;
          IF TG_OP = 'UPDATE' AND EXISTS (
            SELECT 1
              FROM payroll_month_periods p
              CROSS JOIN LATERAL generate_series(
                make_date(p.year, p.month, 1),
                (make_date(p.year, p.month, 1) + interval '1 month - 1 day')::date,
                interval '1 day'
              ) AS locked_days(day_value)
             WHERE p.status = 'LOCKED'
               AND (
                 -- Applicability on a locked calendar day changed.
                 ((day_value::date >= OLD.valid_from AND
                    day_value::date <= COALESCE(OLD.valid_until, '9999-12-31'::date))
                  IS DISTINCT FROM
                  (day_value::date >= NEW.valid_from AND
                    day_value::date <= COALESCE(NEW.valid_until, '9999-12-31'::date)))
                 OR (
                   day_value::date >= OLD.valid_from
                   AND day_value::date <= COALESCE(OLD.valid_until, '9999-12-31'::date)
                   AND day_value::date >= NEW.valid_from
                   AND day_value::date <= COALESCE(NEW.valid_until, '9999-12-31'::date)
                   AND (
                     OLD.person_id IS DISTINCT FROM NEW.person_id
                     OR OLD.monday_minutes IS DISTINCT FROM NEW.monday_minutes
                     OR OLD.tuesday_minutes IS DISTINCT FROM NEW.tuesday_minutes
                     OR OLD.wednesday_minutes IS DISTINCT FROM NEW.wednesday_minutes
                     OR OLD.thursday_minutes IS DISTINCT FROM NEW.thursday_minutes
                     OR OLD.friday_minutes IS DISTINCT FROM NEW.friday_minutes
                     OR OLD.saturday_minutes IS DISTINCT FROM NEW.saturday_minutes
                     OR OLD.sunday_minutes IS DISTINCT FROM NEW.sunday_minutes
                     OR OLD.weekly_total_minutes IS DISTINCT FROM NEW.weekly_total_minutes
                     OR OLD.contract_weekly_minutes IS DISTINCT FROM NEW.contract_weekly_minutes
                     OR OLD.is_confirmed IS DISTINCT FROM NEW.is_confirmed
                     OR OLD.confirmed_by_user_id IS DISTINCT FROM NEW.confirmed_by_user_id
                     OR OLD.confirmed_at IS DISTINCT FROM NEW.confirmed_at
                   )
                 )
               )
          ) THEN
            RAISE EXCEPTION 'payroll_month_locked: weekly schedule change affects a locked day'
              USING ERRCODE = 'P0001';
          END IF;
          RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
        END
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER trg_person_weekly_schedules_payroll_month_open
        BEFORE INSERT OR UPDATE OR DELETE ON person_weekly_schedules
        FOR EACH ROW EXECUTE FUNCTION payroll_guard_schedule_row()
        """
    )

    op.execute(
        """
        CREATE OR REPLACE FUNCTION payroll_guard_opening_balance_row()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(5259609);
          IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.is_confirmed THEN
            RAISE EXCEPTION 'confirmed payroll opening balance is immutable'
              USING ERRCODE = 'P0001';
          END IF;
          RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
        END
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER trg_person_hours_opening_balances_immutable
        BEFORE INSERT OR UPDATE OR DELETE ON person_hours_opening_balances
        FOR EACH ROW EXECUTE FUNCTION payroll_guard_opening_balance_row()
        """
    )

    op.execute(
        """
        CREATE OR REPLACE FUNCTION payroll_reject_append_only_change()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'P0001';
        END
        $$
        """
    )
    for table in (
        "payroll_month_snapshots",
        "payroll_month_person_snapshots",
        "payroll_month_artifacts",
        "payroll_month_audits",
    ):
        op.execute(
            f"""
            CREATE TRIGGER trg_{table}_append_only
            BEFORE UPDATE OR DELETE ON {table}
            FOR EACH ROW EXECUTE FUNCTION payroll_reject_append_only_change()
            """
        )


def downgrade() -> None:
    connection = op.get_bind()
    if connection.dialect.name != "postgresql":
        return
    for table in (
        "payroll_month_audits",
        "payroll_month_artifacts",
        "payroll_month_person_snapshots",
        "payroll_month_snapshots",
    ):
        op.execute(f"DROP TRIGGER IF EXISTS trg_{table}_append_only ON {table}")
    op.execute("DROP TRIGGER IF EXISTS trg_person_hours_opening_balances_immutable ON person_hours_opening_balances")
    op.execute("DROP TRIGGER IF EXISTS trg_person_weekly_schedules_payroll_month_open ON person_weekly_schedules")
    op.execute("DROP TRIGGER IF EXISTS trg_person_hours_account_entries_payroll_month_open ON person_hours_account_entries")
    op.execute("DROP TRIGGER IF EXISTS trg_absences_payroll_month_open ON absences")
    op.execute("DROP TRIGGER IF EXISTS trg_person_work_days_payroll_month_open ON person_work_days")
    op.execute("DROP TRIGGER IF EXISTS trg_work_time_entries_payroll_month_open ON work_time_entries")
    for function in (
        "payroll_reject_append_only_change()",
        "payroll_guard_opening_balance_row()",
        "payroll_guard_schedule_row()",
        "payroll_guard_hours_account_row()",
        "payroll_guard_absence_row()",
        "payroll_guard_dated_row()",
        "payroll_assert_range_open(date,date)",
        "payroll_assert_month_open(date)",
        "payroll_month_advisory_key(integer,integer)",
    ):
        op.execute(f"DROP FUNCTION IF EXISTS {function}")
