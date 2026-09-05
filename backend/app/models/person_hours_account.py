from datetime import date, datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
    and_,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class PersonHoursAccountEntry(TimestampMixin, Base):
    __tablename__ = "person_hours_account_entries"
    __table_args__ = (
        CheckConstraint(
            "ledger_system IN ('legacy', 'daily')",
            name="ck_person_hours_account_entries_ledger_system",
        ),
        CheckConstraint(
            "ledger_system <> 'daily' OR "
            "(effective_date IS NOT NULL AND effective_date >= '2026-08-01')",
            name="ck_person_hours_account_entries_daily_effective_date",
        ),
        Index("ix_person_hours_account_entries_person_created", "person_id", "created_at"),
        Index("ix_person_hours_account_entries_week", "person_id", "iso_year", "iso_week"),
        Index(
            "ix_person_hours_account_entries_person_effective",
            "person_id",
            "effective_date",
        ),
        Index(
            "ix_person_hours_account_entries_source",
            "source_type",
            "source_reference_id",
        ),
        Index(
            "uq_person_hours_account_entries_active_month",
            "person_id", "effective_date", unique=True,
            sqlite_where=text("entry_type = 'monthly_balance' AND is_active = 1"),
            postgresql_where=text("entry_type = 'monthly_balance' AND is_active = true"),
        ),
        Index(
            "uq_person_hours_account_entries_active_daily",
            "person_id",
            "effective_date",
            unique=True,
            sqlite_where=and_(
                text("ledger_system = 'daily'"),
                text("entry_type = 'daily_balance'"),
                text("is_active = 1"),
            ),
            postgresql_where=and_(
                text("ledger_system = 'daily'"),
                text("entry_type = 'daily_balance'"),
                text("is_active = true"),
            ),
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    person_id: Mapped[int] = mapped_column(
        ForeignKey("persons.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    entry_type: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    minutes_delta: Mapped[int] = mapped_column(Integer, nullable=False)
    balance_after_minutes: Mapped[int | None] = mapped_column(Integer)
    note: Mapped[str] = mapped_column(Text, nullable=False)
    iso_year: Mapped[int | None] = mapped_column(Integer)
    iso_week: Mapped[int | None] = mapped_column(Integer)
    weekly_review_id: Mapped[int | None] = mapped_column(
        ForeignKey("time_entry_weekly_reviews.id", ondelete="SET NULL"),
        index=True,
    )
    weekly_work_minutes: Mapped[int | None] = mapped_column(Integer)
    weekly_actual_minutes: Mapped[int | None] = mapped_column(Integer)
    weekly_required_minutes: Mapped[int | None] = mapped_column(Integer)
    weekly_overtime_absence_minutes: Mapped[int | None] = mapped_column(Integer)
    weekly_absence_breakdown: Mapped[list[dict] | None] = mapped_column(JSON)
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"),
        index=True,
    )
    ledger_system: Mapped[str] = mapped_column(
        String(20), nullable=False, default="legacy", server_default="legacy", index=True
    )
    effective_date: Mapped[date | None] = mapped_column(Date, index=True)
    source_type: Mapped[str | None] = mapped_column(String(40))
    source_reference_id: Mapped[str | None] = mapped_column(String(120))
    idempotency_key: Mapped[str | None] = mapped_column(String(255), unique=True)
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true", index=True
    )
    superseded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    daily_target_minutes: Mapped[int | None] = mapped_column(Integer)
    daily_work_minutes: Mapped[int | None] = mapped_column(Integer)
    daily_credit_minutes: Mapped[int | None] = mapped_column(Integer)
    daily_actual_minutes: Mapped[int | None] = mapped_column(Integer)
    daily_absence_type: Mapped[str | None] = mapped_column(String(40))
    source_fingerprint: Mapped[str | None] = mapped_column(String(64))
    source_payload: Mapped[dict | None] = mapped_column(JSON)

    person = relationship("Person", back_populates="hours_account_entries")
    weekly_review = relationship("TimeEntryWeeklyReview")
    created_by = relationship("User")
