from datetime import date, datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


PAYROLL_LEDGER_CUTOVER_DATE = date(2026, 8, 1)
PAYROLL_LEDGER_OPENING_DATE = date(2026, 7, 31)


class PersonWeeklySchedule(TimestampMixin, Base):
    """Effective-dated and explicitly confirmed daily target minutes."""

    __tablename__ = "person_weekly_schedules"
    __table_args__ = (
        UniqueConstraint(
            "person_id", "valid_from", name="uq_person_weekly_schedules_person_start"
        ),
        CheckConstraint(
            "valid_until IS NULL OR valid_until >= valid_from",
            name="ck_person_weekly_schedules_date_range",
        ),
        CheckConstraint(
            "monday_minutes >= 0 AND tuesday_minutes >= 0 "
            "AND wednesday_minutes >= 0 AND thursday_minutes >= 0 "
            "AND friday_minutes >= 0 AND saturday_minutes >= 0 "
            "AND sunday_minutes >= 0",
            name="ck_person_weekly_schedules_nonnegative",
        ),
        CheckConstraint(
            "weekly_total_minutes = monday_minutes + tuesday_minutes "
            "+ wednesday_minutes + thursday_minutes + friday_minutes "
            "+ saturday_minutes + sunday_minutes",
            name="ck_person_weekly_schedules_total",
        ),
        CheckConstraint(
            "(is_confirmed = false AND confirmed_at IS NULL "
            "AND confirmed_by_user_id IS NULL) OR "
            "(is_confirmed = true AND confirmed_at IS NOT NULL "
            "AND confirmed_by_user_id IS NOT NULL)",
            name="ck_person_weekly_schedules_confirmation",
        ),
        Index(
            "ix_person_weekly_schedules_person_validity",
            "person_id",
            "valid_from",
            "valid_until",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    person_id: Mapped[int] = mapped_column(
        ForeignKey("persons.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    valid_from: Mapped[date] = mapped_column(Date, nullable=False)
    valid_until: Mapped[date | None] = mapped_column(Date)
    monday_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    tuesday_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    wednesday_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    thursday_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    friday_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    saturday_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    sunday_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    weekly_total_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    contract_weekly_minutes: Mapped[int | None] = mapped_column(Integer)
    is_confirmed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    note: Mapped[str | None] = mapped_column(Text)
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    confirmed_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), index=True
    )
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    person = relationship("Person", back_populates="weekly_schedules")
    created_by = relationship("User", foreign_keys=[created_by_user_id])
    confirmed_by = relationship("User", foreign_keys=[confirmed_by_user_id])

    @property
    def weekday_minutes(self) -> tuple[int, int, int, int, int, int, int]:
        return (
            self.monday_minutes,
            self.tuesday_minutes,
            self.wednesday_minutes,
            self.thursday_minutes,
            self.friday_minutes,
            self.saturday_minutes,
            self.sunday_minutes,
        )

    def target_minutes_for(self, work_date: date) -> int:
        return self.weekday_minutes[work_date.weekday()]


class PersonHoursOpeningBalance(TimestampMixin, Base):
    """Manually verified legacy balance at the fixed cutover boundary."""

    __tablename__ = "person_hours_opening_balances"
    __table_args__ = (
        UniqueConstraint(
            "person_id", "as_of_date", name="uq_person_hours_opening_balances_person_date"
        ),
        CheckConstraint(
            "as_of_date = '2026-07-31'",
            name="ck_person_hours_opening_balances_cutover_date",
        ),
        CheckConstraint(
            "(is_confirmed = false AND confirmed_at IS NULL "
            "AND confirmed_by_user_id IS NULL) OR "
            "(is_confirmed = true AND confirmed_at IS NOT NULL "
            "AND confirmed_by_user_id IS NOT NULL)",
            name="ck_person_hours_opening_balances_confirmation",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    person_id: Mapped[int] = mapped_column(
        ForeignKey("persons.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    as_of_date: Mapped[date] = mapped_column(
        Date, nullable=False, default=PAYROLL_LEDGER_OPENING_DATE
    )
    balance_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    entry_type: Mapped[str] = mapped_column(
        String(40), nullable=False, default="legacy_opening_balance"
    )
    is_confirmed: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    note: Mapped[str | None] = mapped_column(Text)
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    confirmed_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT"), index=True
    )
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    person = relationship("Person", back_populates="hours_opening_balance")
    created_by = relationship("User", foreign_keys=[created_by_user_id])
    confirmed_by = relationship("User", foreign_keys=[confirmed_by_user_id])
