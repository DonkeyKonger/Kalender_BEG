"""Add person-level payroll month approvals.

Revision ID: 20260904_0111
Revises: 20260903_0110
Create Date: 2026-09-04
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260904_0111"
down_revision: str | None = "20260903_0110"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "payroll_month_person_approvals",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("year", sa.Integer(), nullable=False),
        sa.Column("month", sa.Integer(), nullable=False),
        sa.Column("person_id", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="OPEN"),
        sa.Column("approval_version", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("ledger_reference_id", sa.String(length=140), nullable=True),
        sa.Column("blocker_snapshot_json", sa.JSON(), nullable=False, server_default="[]"),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("approved_by_user_id", sa.Integer(), nullable=True),
        sa.Column("reopened_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reopened_by_user_id", sa.Integer(), nullable=True),
        sa.Column("reopen_reason", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("year BETWEEN 2000 AND 2100", name="ck_payroll_month_person_approvals_year"),
        sa.CheckConstraint("month BETWEEN 1 AND 12", name="ck_payroll_month_person_approvals_month"),
        sa.CheckConstraint("status IN ('OPEN', 'APPROVED')", name="ck_payroll_month_person_approvals_status"),
        sa.ForeignKeyConstraint(["approved_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["person_id"], ["persons.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["reopened_by_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("year", "month", "person_id", name="uq_payroll_month_person_approval"),
    )
    op.create_index(
        "ix_payroll_month_person_approvals_approved_by_user_id",
        "payroll_month_person_approvals",
        ["approved_by_user_id"],
    )
    op.create_index(
        "ix_payroll_month_person_approvals_person_id",
        "payroll_month_person_approvals",
        ["person_id"],
    )
    op.create_index(
        "ix_payroll_month_person_approvals_period",
        "payroll_month_person_approvals",
        ["year", "month"],
    )
    op.create_index(
        "ix_payroll_month_person_approvals_reopened_by_user_id",
        "payroll_month_person_approvals",
        ["reopened_by_user_id"],
    )
    op.create_table(
        "payroll_month_person_approval_artifacts",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("approval_id", sa.Integer(), nullable=False),
        sa.Column("year", sa.Integer(), nullable=False),
        sa.Column("month", sa.Integer(), nullable=False),
        sa.Column("person_id", sa.Integer(), nullable=False),
        sa.Column("approval_version", sa.Integer(), nullable=False),
        sa.Column("ledger_reference_id", sa.String(length=140), nullable=False),
        sa.Column("filename", sa.String(length=255), nullable=False),
        sa.Column("media_type", sa.String(length=120), nullable=False),
        sa.Column("content", sa.LargeBinary(), nullable=False),
        sa.Column("byte_size", sa.Integer(), nullable=False),
        sa.Column("content_sha256", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["approval_id"], ["payroll_month_person_approvals.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["person_id"], ["persons.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "approval_id",
            "approval_version",
            name="uq_payroll_month_person_approval_artifact_version",
        ),
    )
    op.create_index(
        "ix_payroll_month_person_approval_artifacts_approval_id",
        "payroll_month_person_approval_artifacts",
        ["approval_id"],
    )
    op.create_index(
        "ix_payroll_month_person_approval_artifacts_person_id",
        "payroll_month_person_approval_artifacts",
        ["person_id"],
    )
    op.create_index(
        "ix_payroll_month_person_approval_artifacts_period",
        "payroll_month_person_approval_artifacts",
        ["year", "month"],
    )
    op.create_index(
        "ix_payroll_month_person_approval_artifacts_person_period",
        "payroll_month_person_approval_artifacts",
        ["person_id", "year", "month"],
    )
    connection = op.get_bind()
    if connection.dialect.name != "postgresql":
        return

    op.execute(
        """
        CREATE OR REPLACE FUNCTION payroll_assert_person_month_open(p_person_id integer, p_date date)
        RETURNS void
        LANGUAGE plpgsql
        AS $$
        BEGIN
          PERFORM pg_advisory_xact_lock(
            payroll_month_advisory_key(EXTRACT(YEAR FROM p_date)::integer,
                                       EXTRACT(MONTH FROM p_date)::integer)
          );
          IF EXISTS (
            SELECT 1 FROM payroll_month_person_approvals p
             WHERE p.person_id = p_person_id
               AND p.year = EXTRACT(YEAR FROM p_date)::integer
               AND p.month = EXTRACT(MONTH FROM p_date)::integer
               AND p.status = 'APPROVED'
          ) THEN
            RAISE EXCEPTION 'payroll_person_month_locked: % person %', to_char(p_date, 'YYYY-MM'), p_person_id
              USING ERRCODE = 'P0001';
          END IF;
        END
        $$
        """
    )
    op.execute(
        """
        CREATE OR REPLACE FUNCTION payroll_assert_person_range_open(p_person_id integer, p_start date, p_end date)
        RETURNS void
        LANGUAGE plpgsql
        AS $$
        DECLARE cursor_month date;
        BEGIN
          cursor_month := date_trunc('month', p_start)::date;
          WHILE cursor_month <= date_trunc('month', p_end)::date LOOP
            PERFORM payroll_assert_person_month_open(p_person_id, cursor_month);
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
            PERFORM payroll_assert_person_month_open(OLD.person_id, OLD.work_date);
          END IF;
          IF TG_OP IN ('INSERT', 'UPDATE') THEN
            PERFORM payroll_assert_month_open(NEW.work_date);
            PERFORM payroll_assert_person_month_open(NEW.person_id, NEW.work_date);
          END IF;
          RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
        END
        $$
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
            PERFORM payroll_assert_person_range_open(OLD.person_id, OLD.start_date, OLD.end_date);
          END IF;
          IF TG_OP IN ('INSERT', 'UPDATE') THEN
            PERFORM payroll_assert_range_open(NEW.start_date, NEW.end_date);
            PERFORM payroll_assert_person_range_open(NEW.person_id, NEW.start_date, NEW.end_date);
          END IF;
          RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
        END
        $$
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
    )
    op.execute(
        """
        CREATE OR REPLACE FUNCTION payroll_guard_schedule_row()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        DECLARE range_start date; range_end date;
        BEGIN
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
            IF EXISTS (
              SELECT 1 FROM payroll_month_person_approvals p
               WHERE p.person_id = OLD.person_id
                 AND p.status = 'APPROVED'
                 AND make_date(p.year, p.month, 1) <= range_end
                 AND (make_date(p.year, p.month, 1) + interval '1 month - 1 day')::date >= range_start
            ) THEN
              RAISE EXCEPTION 'payroll_person_month_locked: weekly schedule overlaps an approved person month'
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
            IF EXISTS (
              SELECT 1 FROM payroll_month_person_approvals p
               WHERE p.person_id = NEW.person_id
                 AND p.status = 'APPROVED'
                 AND make_date(p.year, p.month, 1) <= range_end
                 AND (make_date(p.year, p.month, 1) + interval '1 month - 1 day')::date >= range_start
            ) THEN
              RAISE EXCEPTION 'payroll_person_month_locked: weekly schedule overlaps an approved person month'
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
          IF TG_OP = 'UPDATE' AND EXISTS (
            SELECT 1
              FROM payroll_month_person_approvals p
              CROSS JOIN LATERAL generate_series(
                make_date(p.year, p.month, 1),
                (make_date(p.year, p.month, 1) + interval '1 month - 1 day')::date,
                interval '1 day'
              ) AS approved_days(day_value)
             WHERE p.status = 'APPROVED'
               AND (p.person_id = OLD.person_id OR p.person_id = NEW.person_id)
               AND (
                 ((p.person_id = OLD.person_id
                   AND day_value::date >= OLD.valid_from
                   AND day_value::date <= COALESCE(OLD.valid_until, '9999-12-31'::date))
                  IS DISTINCT FROM
                  (p.person_id = NEW.person_id
                   AND day_value::date >= NEW.valid_from
                   AND day_value::date <= COALESCE(NEW.valid_until, '9999-12-31'::date)))
                 OR (
                   p.person_id = OLD.person_id
                   AND p.person_id = NEW.person_id
                   AND day_value::date >= OLD.valid_from
                   AND day_value::date <= COALESCE(OLD.valid_until, '9999-12-31'::date)
                   AND day_value::date >= NEW.valid_from
                   AND day_value::date <= COALESCE(NEW.valid_until, '9999-12-31'::date)
                   AND (
                     OLD.monday_minutes IS DISTINCT FROM NEW.monday_minutes
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
            RAISE EXCEPTION 'payroll_person_month_locked: weekly schedule change affects an approved person month'
              USING ERRCODE = 'P0001';
          END IF;
          RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
        END
        $$
        """
    )
    op.execute(
        """
        CREATE TRIGGER trg_payroll_month_person_approval_artifacts_append_only
        BEFORE UPDATE OR DELETE ON payroll_month_person_approval_artifacts
        FOR EACH ROW EXECUTE FUNCTION payroll_reject_append_only_change()
        """
    )


def downgrade() -> None:
    connection = op.get_bind()
    if connection.dialect.name == "postgresql":
        op.execute(
            "DROP TRIGGER IF EXISTS trg_payroll_month_person_approval_artifacts_append_only "
            "ON payroll_month_person_approval_artifacts"
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
        op.execute(_PAYROLL_GUARD_SCHEDULE_ROW_WITHOUT_PERSON_APPROVALS)
        op.execute("DROP FUNCTION IF EXISTS payroll_assert_person_range_open(integer,date,date)")
        op.execute("DROP FUNCTION IF EXISTS payroll_assert_person_month_open(integer,date)")
    op.drop_index("ix_payroll_month_person_approval_artifacts_person_period", table_name="payroll_month_person_approval_artifacts")
    op.drop_index("ix_payroll_month_person_approval_artifacts_period", table_name="payroll_month_person_approval_artifacts")
    op.drop_index("ix_payroll_month_person_approval_artifacts_person_id", table_name="payroll_month_person_approval_artifacts")
    op.drop_index("ix_payroll_month_person_approval_artifacts_approval_id", table_name="payroll_month_person_approval_artifacts")
    op.drop_table("payroll_month_person_approval_artifacts")
    op.drop_index("ix_payroll_month_person_approvals_reopened_by_user_id", table_name="payroll_month_person_approvals")
    op.drop_index("ix_payroll_month_person_approvals_period", table_name="payroll_month_person_approvals")
    op.drop_index("ix_payroll_month_person_approvals_person_id", table_name="payroll_month_person_approvals")
    op.drop_index("ix_payroll_month_person_approvals_approved_by_user_id", table_name="payroll_month_person_approvals")
    op.drop_table("payroll_month_person_approvals")


_PAYROLL_GUARD_SCHEDULE_ROW_WITHOUT_PERSON_APPROVALS = """
CREATE OR REPLACE FUNCTION payroll_guard_schedule_row()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE range_start date; range_end date;
BEGIN
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
