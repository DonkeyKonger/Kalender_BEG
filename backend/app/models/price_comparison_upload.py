from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TimestampMixin


UPLOAD_JOB_STATUSES = (
    "queued",
    "processing",
    "awaiting_confirmation",
    "completed",
    "failed",
    "cancelled",
)


class PriceComparisonUploadJob(TimestampMixin, Base):
    __tablename__ = "price_comparison_upload_jobs"
    __table_args__ = (
        CheckConstraint(
            "status IN ('queued', 'processing', 'awaiting_confirmation', "
            "'completed', 'failed', 'cancelled')",
            name="ck_price_upload_jobs_status",
        ),
        CheckConstraint("kind = 'offers'", name="ck_price_upload_jobs_kind"),
        CheckConstraint("total_bytes > 0", name="ck_price_upload_jobs_total_bytes"),
        UniqueConstraint(
            "created_by_user_id",
            "client_request_id",
            name="uq_price_upload_jobs_user_request",
        ),
        Index("ix_price_upload_jobs_created_by_user_id", "created_by_user_id"),
        Index("ix_price_upload_jobs_status", "status"),
        Index("ix_price_upload_jobs_status_created", "status", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    created_by_user_id: Mapped[int | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    client_request_id: Mapped[str] = mapped_column(String(36), nullable=False)
    request_digest: Mapped[str] = mapped_column(String(64), nullable=False)
    store_identity: Mapped[str] = mapped_column(String(64), nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False, default="offers")
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="queued")
    file_names: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    file_count: Mapped[int] = mapped_column(Integer, nullable=False)
    total_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    duplicates: Mapped[list[dict] | None] = mapped_column(JSON)
    confirmation_revision: Mapped[str | None] = mapped_column(String(64))
    confirmed_duplicates: Mapped[list[str] | None] = mapped_column(JSON)
    result_revision: Mapped[str | None] = mapped_column(String(64))
    message: Mapped[str | None] = mapped_column(Text)
    error: Mapped[str | None] = mapped_column(Text)
    worker_id: Mapped[str | None] = mapped_column(String(160))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class PriceComparisonUploadFile(Base):
    __tablename__ = "price_comparison_upload_files"
    __table_args__ = (
        CheckConstraint("position >= 0", name="ck_price_upload_files_position"),
        CheckConstraint("size > 0", name="ck_price_upload_files_size"),
        UniqueConstraint("job_id", "position", name="uq_price_upload_files_job_position"),
        Index("ix_price_upload_files_job_id", "job_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    job_id: Mapped[str] = mapped_column(
        ForeignKey("price_comparison_upload_jobs.id", ondelete="CASCADE"),
        nullable=False,
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    name: Mapped[str] = mapped_column(String(220), nullable=False)
    size: Mapped[int] = mapped_column(Integer, nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    # Status/list queries never select this table. Worker reads are explicit,
    # and terminal transitions set payload to NULL in the same transaction.
    payload: Mapped[bytes | None] = mapped_column(
        LargeBinary,
        nullable=True,
        deferred=True,
    )
