from datetime import date, datetime

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


PAYROLL_MONTH_OPEN = "OPEN"
PAYROLL_MONTH_LOCKED = "LOCKED"


class PayrollMonthPeriod(TimestampMixin, Base):
    """Mutable pointer to the current state of one payroll month.

    Immutable accounting results live in :class:`PayrollMonthSnapshot`.  Keeping
    the state row separate lets a reopened month retain every former snapshot.
    """

    __tablename__ = "payroll_month_periods"
    __table_args__ = (
        UniqueConstraint("year", "month", name="uq_payroll_month_periods_year_month"),
        CheckConstraint("year BETWEEN 2000 AND 2100", name="ck_payroll_month_periods_year"),
        CheckConstraint("month BETWEEN 1 AND 12", name="ck_payroll_month_periods_month"),
        CheckConstraint(
            "status IN ('OPEN', 'LOCKED')",
            name="ck_payroll_month_periods_status",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    year: Mapped[int] = mapped_column(Integer, nullable=False)
    month: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default=PAYROLL_MONTH_OPEN)
    last_snapshot_version: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    row_version: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    locked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    locked_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    reopened_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reopened_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )

    locked_by = relationship("User", foreign_keys=[locked_by_user_id])
    reopened_by = relationship("User", foreign_keys=[reopened_by_user_id])
    snapshots = relationship(
        "PayrollMonthSnapshot",
        back_populates="period",
        order_by="PayrollMonthSnapshot.version",
        passive_deletes=True,
    )
    audits = relationship("PayrollMonthAudit", back_populates="period", passive_deletes=True)


class PayrollMonthSnapshot(Base):
    """Append-only, content-addressed result of one successful month close."""

    __tablename__ = "payroll_month_snapshots"
    __table_args__ = (
        UniqueConstraint("period_id", "version", name="uq_payroll_month_snapshots_version"),
        UniqueConstraint("reference_id", name="uq_payroll_month_snapshots_reference"),
        Index("ix_payroll_month_snapshots_period_created", "period_id", "created_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    period_id: Mapped[int] = mapped_column(
        ForeignKey("payroll_month_periods.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    reference_id: Mapped[str] = mapped_column(String(100), nullable=False)
    period_start: Mapped[date] = mapped_column(Date, nullable=False)
    period_end: Mapped[date] = mapped_column(Date, nullable=False)
    cutover_date: Mapped[date] = mapped_column(Date, nullable=False)
    payload_json: Mapped[dict] = mapped_column(JSON, nullable=False)
    payload_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    period = relationship("PayrollMonthPeriod", back_populates="snapshots")
    created_by = relationship("User")
    person_rows = relationship(
        "PayrollMonthPersonSnapshot",
        back_populates="snapshot",
        order_by="PayrollMonthPersonSnapshot.person_id",
        passive_deletes=True,
    )
    artifacts = relationship(
        "PayrollMonthArtifact",
        back_populates="snapshot",
        order_by="PayrollMonthArtifact.artifact_key",
        passive_deletes=True,
    )


class PayrollMonthPersonSnapshot(Base):
    __tablename__ = "payroll_month_person_snapshots"
    __table_args__ = (
        UniqueConstraint("snapshot_id", "person_id", name="uq_payroll_month_person_snapshot"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    snapshot_id: Mapped[int] = mapped_column(
        ForeignKey("payroll_month_snapshots.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    person_id: Mapped[int] = mapped_column(
        ForeignKey("persons.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    person_name: Mapped[str] = mapped_column(String(240), nullable=False)
    opening_balance_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    movement_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    closing_balance_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    daily_values_json: Mapped[list[dict]] = mapped_column(JSON, nullable=False, default=list)
    source_sha256: Mapped[str] = mapped_column(String(64), nullable=False)

    snapshot = relationship("PayrollMonthSnapshot", back_populates="person_rows")
    person = relationship("Person")


class PayrollMonthArtifact(Base):
    """Exact generated download bytes retained with their source snapshot."""

    __tablename__ = "payroll_month_artifacts"
    __table_args__ = (
        UniqueConstraint("snapshot_id", "artifact_key", name="uq_payroll_month_artifact_key"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    snapshot_id: Mapped[int] = mapped_column(
        ForeignKey("payroll_month_snapshots.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    artifact_key: Mapped[str] = mapped_column(String(80), nullable=False)
    person_id: Mapped[int | None] = mapped_column(
        ForeignKey("persons.id", ondelete="RESTRICT"), index=True
    )
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    media_type: Mapped[str] = mapped_column(String(120), nullable=False)
    content: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    byte_size: Mapped[int] = mapped_column(Integer, nullable=False)
    content_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    snapshot = relationship("PayrollMonthSnapshot", back_populates="artifacts")
    person = relationship("Person")


class PayrollMonthAudit(Base):
    __tablename__ = "payroll_month_audits"
    __table_args__ = (Index("ix_payroll_month_audits_period_created", "period_id", "created_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    period_id: Mapped[int] = mapped_column(
        ForeignKey("payroll_month_periods.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    snapshot_id: Mapped[int | None] = mapped_column(
        ForeignKey("payroll_month_snapshots.id", ondelete="RESTRICT"), index=True
    )
    action: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    status_before: Mapped[str] = mapped_column(String(16), nullable=False)
    status_after: Mapped[str] = mapped_column(String(16), nullable=False)
    reason: Mapped[str | None] = mapped_column(Text)
    details_json: Mapped[dict | None] = mapped_column(JSON)
    user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    period = relationship("PayrollMonthPeriod", back_populates="audits")
    snapshot = relationship("PayrollMonthSnapshot")
    user = relationship("User")
