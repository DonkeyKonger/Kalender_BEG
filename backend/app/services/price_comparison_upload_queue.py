"""Persistent, process-safe upload queue for price-comparison offer PDFs."""

from __future__ import annotations

import asyncio
from contextlib import contextmanager, suppress
from datetime import UTC, datetime, timedelta
import hashlib
import json
import logging
import os
import socket
from threading import Event, Lock, Thread, current_thread
import time
from typing import Callable
from uuid import UUID, uuid4

from fastapi import HTTPException
from sqlalchemy import case, delete, func, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from app.core.database import SessionLocal
from app.models.enums import UserRole
from app.models.price_comparison_upload import (
    PriceComparisonUploadFile,
    PriceComparisonUploadJob,
)
from app.models.user import User
from app.services.price_comparison_storage import (
    MAX_BATCH_BYTES,
    MAX_FILE_BYTES,
    get_price_storage,
    safe_name,
)


logger = logging.getLogger(__name__)

QUEUE_LEADER_LOCK_KEY = 5342519018
QUEUE_ENQUEUE_LOCK_KEY = 5342519019
MAX_ACTIVE_JOBS_PER_USER = 10
MAX_ACTIVE_BYTES_PER_USER = 320 * 1024 * 1024
MAX_ACTIVE_BYTES_GLOBAL = 1024 * 1024 * 1024
POLL_SECONDS = 1.0
HEARTBEAT_SECONDS = 10.0
INTERRUPTED_AFTER_SECONDS = 60.0
WAITING_PAYLOAD_DAYS = 7
HISTORY_DAYS = 30
CLEANUP_SECONDS = 60.0

ACTIVE_STATUSES = ("queued", "processing", "awaiting_confirmation")
TERMINAL_STATUSES = ("completed", "failed", "cancelled")
_local_enqueue_lock = Lock()
_local_leader_lock = Lock()


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _canonical_uuid(value: str) -> str:
    try:
        return str(UUID(str(value)))
    except (ValueError, AttributeError) as exc:
        raise HTTPException(422, "Ungültige Upload-Anfragekennung.") from exc


def _request_digest(kind: str, uploads: list[tuple[str, bytes]]) -> str:
    manifest = [
        {
            "name": name,
            "size": len(raw),
            "sha256": hashlib.sha256(raw).hexdigest(),
        }
        for name, raw in uploads
    ]
    return hashlib.sha256(
        json.dumps(
            {"kind": kind, "files": manifest},
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()


def _store_identity(service: object) -> str:
    store = getattr(service, "store", None)
    if store is None or not getattr(store, "configured", False):
        raise HTTPException(503, "Der Preisvergleich-Speicher ist nicht konfiguriert.")
    identity = getattr(store, "identity", None)
    if not isinstance(identity, str) or not identity:
        raise HTTPException(503, "Der Preisvergleich-Speicher ist nicht eindeutig konfiguriert.")
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


def job_to_api(job: PriceComparisonUploadJob) -> dict:
    return {
        "id": job.id,
        "client_request_id": job.client_request_id,
        "status": job.status,
        "file_names": list(job.file_names or []),
        "created_at": job.created_at,
        "updated_at": job.updated_at,
        "message": job.message,
        "error": job.error,
        "duplicates": job.duplicates,
        "confirmation_revision": job.confirmation_revision,
        "result_revision": job.result_revision,
    }


class PriceComparisonUploadQueue:
    def __init__(
        self,
        db_factory: sessionmaker = SessionLocal,
        *,
        service_factory: Callable[[], object] | None = None,
        now: Callable[[], datetime] = _utcnow,
    ) -> None:
        self.db_factory = db_factory
        self.service_factory = service_factory or self._default_service
        self.now = now

    @staticmethod
    def _default_service():
        # Imported lazily so route/model tests do not initialize parser state.
        from app.services.price_comparison_service import PriceComparisonService

        return PriceComparisonService(get_price_storage())

    @staticmethod
    def _validate_uploads(kind: str, uploads: list[tuple[str, bytes]]) -> None:
        if kind != "offers":
            raise HTTPException(422, "Die Upload-Warteschlange nimmt nur Angebots-PDFs an.")
        if not uploads or len(uploads) > 200:
            raise HTTPException(422, "Bitte 1 bis 200 Dateien auswählen.")
        total = 0
        names = []
        for name, raw in uploads:
            safe_name(name)
            if not name.lower().endswith(".pdf") or not raw:
                raise HTTPException(422, "Bitte PDF-Angebote hochladen.")
            if len(raw) > MAX_FILE_BYTES:
                raise HTTPException(413, "Datei ist größer als 40 MB.")
            total += len(raw)
            if total > MAX_BATCH_BYTES:
                raise HTTPException(413, "Maximal 160 MB je Upload.")
            if b"%PDF-" not in raw[:1024]:
                raise HTTPException(422, "Ungültige PDF-Datei.")
            names.append(name)
        if len({name.casefold() for name in names}) != len(names):
            raise HTTPException(422, "Ein Upload darf jeden Dateinamen nur einmal enthalten.")

    @contextmanager
    def _enqueue_guard(self, db: Session):
        if db.get_bind().dialect.name == "postgresql":
            db.execute(
                text("SELECT pg_advisory_xact_lock(:key)"),
                {"key": QUEUE_ENQUEUE_LOCK_KEY},
            )
            yield
        else:
            with _local_enqueue_lock:
                yield

    def enqueue(
        self,
        db: Session,
        *,
        user_id: int,
        kind: str,
        uploads: list[tuple[str, bytes]],
        client_request_id: str,
        service: object | None = None,
    ) -> PriceComparisonUploadJob:
        self._validate_uploads(kind, uploads)
        request_id = _canonical_uuid(client_request_id)
        digest = _request_digest(kind, uploads)
        total_bytes = sum(len(raw) for _, raw in uploads)
        scope = _store_identity(service or self.service_factory())

        with self._enqueue_guard(db):
            existing = db.scalar(
                select(PriceComparisonUploadJob).where(
                    PriceComparisonUploadJob.created_by_user_id == user_id,
                    PriceComparisonUploadJob.client_request_id == request_id,
                )
            )
            if existing is not None:
                if existing.request_digest != digest or existing.store_identity != scope:
                    raise HTTPException(
                        409,
                        "Diese Upload-Anfragekennung wurde bereits für andere Dateien "
                        "oder einen anderen Speicher verwendet.",
                    )
                return existing

            active_count, user_bytes = db.execute(
                select(
                    func.count(PriceComparisonUploadJob.id),
                    func.coalesce(func.sum(PriceComparisonUploadJob.total_bytes), 0),
                ).where(
                    PriceComparisonUploadJob.created_by_user_id == user_id,
                    PriceComparisonUploadJob.status.in_(ACTIVE_STATUSES),
                )
            ).one()
            global_bytes = db.scalar(
                select(func.coalesce(func.sum(PriceComparisonUploadJob.total_bytes), 0)).where(
                    PriceComparisonUploadJob.status.in_(ACTIVE_STATUSES)
                )
            )
            if int(active_count) >= MAX_ACTIVE_JOBS_PER_USER:
                raise HTTPException(429, "Zu viele offene Angebots-Uploads.")
            if int(user_bytes) + total_bytes > MAX_ACTIVE_BYTES_PER_USER:
                raise HTTPException(429, "Zu viele offene Upload-Daten für diesen Benutzer.")
            if int(global_bytes or 0) + total_bytes > MAX_ACTIVE_BYTES_GLOBAL:
                raise HTTPException(503, "Die Upload-Warteschlange ist derzeit voll.")

            job = PriceComparisonUploadJob(
                id=str(uuid4()),
                created_by_user_id=user_id,
                client_request_id=request_id,
                request_digest=digest,
                store_identity=scope,
                kind=kind,
                status="queued",
                file_names=[name for name, _ in uploads],
                file_count=len(uploads),
                total_bytes=total_bytes,
                message="Upload wartet auf Verarbeitung.",
            )
            db.add(job)
            db.flush()
            for position, (name, raw) in enumerate(uploads):
                db.add(
                    PriceComparisonUploadFile(
                        job_id=job.id,
                        position=position,
                        name=name,
                        size=len(raw),
                        sha256=hashlib.sha256(raw).hexdigest(),
                        payload=raw,
                    )
                )
            try:
                db.commit()
            except IntegrityError:
                db.rollback()
                raced = db.scalar(
                    select(PriceComparisonUploadJob).where(
                        PriceComparisonUploadJob.created_by_user_id == user_id,
                        PriceComparisonUploadJob.client_request_id == request_id,
                    )
                )
                if raced is None or raced.request_digest != digest or raced.store_identity != scope:
                    raise HTTPException(
                        409, "Die Upload-Anfrage konnte nicht eindeutig gespeichert werden."
                    ) from None
                return raced
            db.refresh(job)
            return job

    def list_for_user(
        self, db: Session, user_id: int, *, service: object | None = None
    ) -> list[PriceComparisonUploadJob]:
        scope = _store_identity(service or self.service_factory())
        return list(
            db.scalars(
                select(PriceComparisonUploadJob)
                .where(
                    PriceComparisonUploadJob.created_by_user_id == user_id,
                    PriceComparisonUploadJob.store_identity == scope,
                )
                # Keep every actionable job visible even after a user has
                # accumulated more than 100 terminal history entries.
                .order_by(
                    case(
                        (PriceComparisonUploadJob.status.in_(ACTIVE_STATUSES), 0),
                        else_=1,
                    ),
                    PriceComparisonUploadJob.created_at.desc(),
                    PriceComparisonUploadJob.id.desc(),
                )
                .limit(100)
            )
        )

    @staticmethod
    def _authorized(job: PriceComparisonUploadJob, user_id: int, role: UserRole) -> None:
        if job.created_by_user_id != user_id and role != UserRole.ADMIN:
            raise HTTPException(404, "Upload-Auftrag nicht gefunden.")

    def confirm(
        self,
        db: Session,
        *,
        job_id: str,
        user_id: int,
        role: UserRole,
        expected_revision: str,
        confirmed_duplicates: list[str],
    ) -> PriceComparisonUploadJob:
        job = db.scalar(
            select(PriceComparisonUploadJob)
            .where(PriceComparisonUploadJob.id == job_id)
            .with_for_update()
        )
        if job is None:
            raise HTTPException(404, "Upload-Auftrag nicht gefunden.")
        self._authorized(job, user_id, role)
        if job.status != "awaiting_confirmation":
            raise HTTPException(409, "Dieser Upload wartet nicht auf eine Bestätigung.")
        if expected_revision != job.confirmation_revision:
            raise HTTPException(409, "Die Dublettenprüfung ist nicht mehr aktuell.")
        if len(confirmed_duplicates) > 2000 or len(set(confirmed_duplicates)) != len(
            confirmed_duplicates
        ):
            raise HTTPException(422, "Ungültige Dateibestätigung.")
        wanted = {
            entry.get("remove")
            for entry in (job.duplicates or [])
            if isinstance(entry, dict) and isinstance(entry.get("remove"), str)
        }
        if set(confirmed_duplicates) != wanted:
            raise HTTPException(409, "Die bestätigten Dubletten stimmen nicht überein.")
        job.status = "queued"
        job.confirmed_duplicates = sorted(wanted)
        job.message = "Bestätigter Upload wartet auf Verarbeitung."
        job.error = None
        job.worker_id = None
        job.started_at = None
        job.heartbeat_at = None
        job.finished_at = None
        db.commit()
        db.refresh(job)
        return job

    def cancel(
        self,
        db: Session,
        *,
        job_id: str,
        user_id: int,
        role: UserRole,
    ) -> PriceComparisonUploadJob:
        job = db.scalar(
            select(PriceComparisonUploadJob)
            .where(PriceComparisonUploadJob.id == job_id)
            .with_for_update()
        )
        if job is None:
            raise HTTPException(404, "Upload-Auftrag nicht gefunden.")
        self._authorized(job, user_id, role)
        if job.status not in {"queued", "awaiting_confirmation"}:
            raise HTTPException(409, "Dieser Upload kann nicht mehr abgebrochen werden.")
        job.status = "cancelled"
        job.message = "Upload abgebrochen."
        job.error = None
        job.finished_at = self.now()
        self._scrub_payloads(db, job.id)
        db.commit()
        db.refresh(job)
        return job

    @staticmethod
    def _scrub_payloads(db: Session, job_id: str) -> None:
        db.execute(
            update(PriceComparisonUploadFile)
            .where(PriceComparisonUploadFile.job_id == job_id)
            .values(payload=None)
        )

    def recover_interrupted(self) -> int:
        cutoff = self.now() - timedelta(seconds=INTERRUPTED_AFTER_SECONDS)
        with self.db_factory() as db:
            jobs = list(
                db.scalars(
                    select(PriceComparisonUploadJob)
                    .where(
                        PriceComparisonUploadJob.status == "processing",
                        (
                            PriceComparisonUploadJob.heartbeat_at.is_(None)
                            | (PriceComparisonUploadJob.heartbeat_at < cutoff)
                        ),
                    )
                    .with_for_update(skip_locked=True)
                )
            )
            for job in jobs:
                job.status = "failed"
                job.message = "Upload wurde während der Verarbeitung unterbrochen."
                job.error = (
                    "Der Dateistand konnte nach dem Prozessabbruch nicht sicher automatisch "
                    "fortgesetzt werden. Bitte Preisvergleich prüfen und Dateien neu auswählen."
                )
                job.finished_at = self.now()
                self._scrub_payloads(db, job.id)
            db.commit()
            return len(jobs)

    def cleanup(self) -> None:
        waiting_cutoff = self.now() - timedelta(days=WAITING_PAYLOAD_DAYS)
        history_cutoff = self.now() - timedelta(days=HISTORY_DAYS)
        with self.db_factory() as db:
            expired = list(
                db.scalars(
                    select(PriceComparisonUploadJob)
                    .where(
                        PriceComparisonUploadJob.status == "awaiting_confirmation",
                        PriceComparisonUploadJob.updated_at < waiting_cutoff,
                    )
                    .with_for_update(skip_locked=True)
                )
            )
            for job in expired:
                job.status = "failed"
                job.message = "Upload-Bestätigung ist abgelaufen."
                job.error = "Bitte Dateien erneut auswählen."
                job.finished_at = self.now()
                self._scrub_payloads(db, job.id)
            db.execute(
                delete(PriceComparisonUploadJob).where(
                    PriceComparisonUploadJob.status.in_(TERMINAL_STATUSES),
                    PriceComparisonUploadJob.updated_at < history_cutoff,
                )
            )
            db.commit()

    def _claim_next(self, worker_id: str) -> str | None:
        with self.db_factory() as db:
            with self._enqueue_guard(db):
                # This transaction-level guard makes the processing check and
                # claim atomic even if two former leaders temporarily coexist.
                if db.scalar(
                    select(PriceComparisonUploadJob.id)
                    .where(PriceComparisonUploadJob.status == "processing")
                    .limit(1)
                ):
                    return None
                statement = (
                    select(PriceComparisonUploadJob)
                    .where(PriceComparisonUploadJob.status == "queued")
                    .order_by(PriceComparisonUploadJob.created_at, PriceComparisonUploadJob.id)
                    .limit(1)
                    .with_for_update(skip_locked=True)
                )
                job = db.scalar(statement)
                if job is None:
                    return None
                now = self.now()
                job.status = "processing"
                job.worker_id = worker_id
                job.started_at = now
                job.heartbeat_at = now
                job.finished_at = None
                job.message = "Angebote werden eingelesen."
                job.error = None
                db.commit()
                return job.id

    def _uploads(self, job_id: str) -> list[tuple[str, bytes]]:
        with self.db_factory() as db:
            rows = db.execute(
                select(
                    PriceComparisonUploadFile.name,
                    PriceComparisonUploadFile.size,
                    PriceComparisonUploadFile.sha256,
                    PriceComparisonUploadFile.payload,
                )
                .where(PriceComparisonUploadFile.job_id == job_id)
                .order_by(PriceComparisonUploadFile.position)
            ).all()
        uploads = []
        for name, size, digest, payload in rows:
            if (
                payload is None
                or len(payload) != size
                or hashlib.sha256(payload).hexdigest() != digest
            ):
                raise RuntimeError("queued upload payload is unavailable or corrupt")
            uploads.append((name, payload))
        if not uploads:
            raise RuntimeError("queued upload has no payload")
        return uploads

    def _heartbeat(self, job_id: str, worker_id: str, stop: Event) -> None:
        while not stop.wait(HEARTBEAT_SECONDS):
            try:
                with self.db_factory() as db:
                    db.execute(
                        update(PriceComparisonUploadJob)
                        .where(
                            PriceComparisonUploadJob.id == job_id,
                            PriceComparisonUploadJob.status == "processing",
                            PriceComparisonUploadJob.worker_id == worker_id,
                        )
                        .values(heartbeat_at=self.now())
                    )
                    db.commit()
            except Exception:
                logger.exception("Price upload queue heartbeat failed: job_id=%s", job_id)

    @contextmanager
    def _heartbeat_thread(self, job_id: str, worker_id: str):
        stop = Event()
        thread = Thread(
            target=self._heartbeat,
            args=(job_id, worker_id, stop),
            name="price-upload-heartbeat",
            daemon=True,
        )
        thread.start()
        try:
            yield
        finally:
            stop.set()
            thread.join()

    def _finish_duplicate(self, job_id: str, detail: dict) -> None:
        duplicates = detail.get("duplicates")
        revision = detail.get("revision")
        if not isinstance(duplicates, list) or not isinstance(revision, str):
            raise RuntimeError("invalid duplicate preview from price upload service")
        with self.db_factory() as db:
            job = db.scalar(
                select(PriceComparisonUploadJob)
                .where(PriceComparisonUploadJob.id == job_id)
                .with_for_update()
            )
            if job is None or job.status != "processing":
                return
            job.status = "awaiting_confirmation"
            job.duplicates = duplicates
            job.confirmation_revision = revision
            job.confirmed_duplicates = None
            job.message = str(detail.get("message") or "Dubletten müssen bestätigt werden.")
            job.error = None
            job.worker_id = None
            job.heartbeat_at = None
            db.commit()

    def _requeue_unconfirmed(self, job_id: str) -> None:
        with self.db_factory() as db:
            job = db.scalar(
                select(PriceComparisonUploadJob)
                .where(PriceComparisonUploadJob.id == job_id)
                .with_for_update()
            )
            if job is None or job.status != "processing":
                return
            job.status = "queued"
            job.duplicates = None
            job.confirmation_revision = None
            job.confirmed_duplicates = None
            job.message = "Der Dateistand hat sich geändert; Dubletten werden neu geprüft."
            job.error = None
            job.worker_id = None
            job.started_at = None
            job.heartbeat_at = None
            db.commit()

    def _finish_terminal(
        self,
        job_id: str,
        *,
        status: str,
        message: str,
        error: str | None = None,
        result_revision: str | None = None,
    ) -> None:
        with self.db_factory() as db:
            job = db.scalar(
                select(PriceComparisonUploadJob)
                .where(PriceComparisonUploadJob.id == job_id)
                .with_for_update()
            )
            if job is None or job.status != "processing":
                return
            job.status = status
            job.message = message
            job.error = error
            job.result_revision = result_revision
            job.duplicates = None
            job.confirmation_revision = None
            job.confirmed_duplicates = None
            job.worker_id = None
            job.heartbeat_at = None
            job.finished_at = self.now()
            self._scrub_payloads(db, job.id)
            db.commit()

    @staticmethod
    def _public_error(exc: HTTPException) -> str:
        if isinstance(exc.detail, str):
            return exc.detail[:1000]
        if isinstance(exc.detail, dict) and isinstance(exc.detail.get("message"), str):
            return exc.detail["message"][:1000]
        return "Angebots-Upload fehlgeschlagen."

    def process_next(self, worker_id: str) -> bool:
        self.recover_interrupted()
        job_id = self._claim_next(worker_id)
        if job_id is None:
            return False
        try:
            with self.db_factory() as db:
                job = db.get(PriceComparisonUploadJob, job_id)
                if job is None or job.status != "processing":
                    return True
                kind = job.kind
                revision = job.confirmation_revision
                confirmed = list(job.confirmed_duplicates or [])
            service = self.service_factory()
            with self.db_factory() as auth_db:
                current_job = auth_db.get(PriceComparisonUploadJob, job_id)
                user = (
                    auth_db.get(User, current_job.created_by_user_id)
                    if current_job is not None and current_job.created_by_user_id is not None
                    else None
                )
                if (
                    current_job is None
                    or current_job.store_identity != _store_identity(service)
                    or user is None
                    or not user.is_active
                    or user.must_change_password
                    or user.role not in {UserRole.ADMIN, UserRole.PROJECT_MANAGER}
                ):
                    raise HTTPException(
                        403,
                        "Der Upload ist für den aktuellen Speicher oder Benutzer nicht mehr freigegeben.",
                    )
            uploads = self._uploads(job_id)
            with self._heartbeat_thread(job_id, worker_id), self.db_factory() as mutation_db:
                result = service.upload_queued(
                    kind,
                    uploads,
                    mutation_db,
                    confirmed_revision=revision,
                    confirmed_duplicates=confirmed or None,
                )
            result_revision = result.get("revision") if isinstance(result, dict) else None
            self._finish_terminal(
                job_id,
                status="completed",
                message="Upload abgeschlossen.",
                result_revision=result_revision,
            )
        except HTTPException as exc:
            if (
                exc.status_code == 409
                and isinstance(exc.detail, dict)
                and exc.detail.get("code") == "duplicate_offers"
            ):
                self._finish_duplicate(job_id, exc.detail)
            elif (
                exc.status_code == 409
                and revision is not None
                and exc.detail
                == "Der Preisvergleich wurde zwischenzeitlich geändert. Bitte neu laden."
            ):
                # Never apply an approval to a newer source revision. Re-run
                # without approval so the service produces a current preview.
                self._requeue_unconfirmed(job_id)
            else:
                self._finish_terminal(
                    job_id,
                    status="failed",
                    message="Upload fehlgeschlagen.",
                    error=self._public_error(exc),
                )
        except Exception:
            logger.exception("Queued price upload failed: job_id=%s", job_id)
            self._finish_terminal(
                job_id,
                status="failed",
                message="Upload fehlgeschlagen.",
                error=(
                    "Der Upload konnte nicht sicher abgeschlossen werden. Bitte den "
                    "Preisvergleich prüfen und die Dateien erneut auswählen."
                ),
            )
        return True


class PriceComparisonUploadWorker:
    def __init__(
        self,
        queue: PriceComparisonUploadQueue | None = None,
        *,
        poll_seconds: float = POLL_SECONDS,
    ) -> None:
        self.queue = queue or PriceComparisonUploadQueue()
        self.poll_seconds = poll_seconds
        self.stop_event = Event()
        self.wake_event = Event()
        self.thread: Thread | None = None
        self.worker_id = f"{socket.gethostname()}:{os.getpid()}:{uuid4()}"
        self.bind = self.queue.db_factory.kw.get("bind")
        if self.bind is None:
            raise RuntimeError("upload queue session factory has no database bind")

    def start(self) -> None:
        if self.thread is not None and self.thread.is_alive():
            return
        self.thread = Thread(
            target=self._run,
            name="price-upload-queue",
            daemon=True,
        )
        self.thread.start()

    def stop(self) -> None:
        self.stop_event.set()
        self.wake_event.set()
        if self.thread is not None and self.thread is not current_thread():
            # Gunicorn's graceful timeout remains the hard bound for an active
            # parse. A forced process exit is recovered as a failed-review job.
            self.thread.join()
        self.thread = None

    def wake(self) -> None:
        self.wake_event.set()

    @contextmanager
    def _leader(self):
        if self.bind.dialect.name != "postgresql":
            acquired = _local_leader_lock.acquire(blocking=False)
            try:
                yield acquired
            finally:
                if acquired:
                    _local_leader_lock.release()
            return

        with self.bind.connect() as connection:
            acquired = bool(
                connection.execute(
                    text("SELECT pg_try_advisory_lock(:key)"),
                    {"key": QUEUE_LEADER_LOCK_KEY},
                ).scalar()
            )
            connection.commit()
            try:
                yield acquired
            finally:
                if acquired:
                    with suppress(Exception):
                        connection.execute(
                            text("SELECT pg_advisory_unlock(:key)"),
                            {"key": QUEUE_LEADER_LOCK_KEY},
                        )
                        connection.commit()

    def _run(self) -> None:
        next_cleanup = 0.0
        while not self.stop_event.is_set():
            try:
                with self._leader() as leader:
                    if not leader:
                        self.stop_event.wait(self.poll_seconds)
                        continue
                    self.queue.recover_interrupted()
                    while not self.stop_event.is_set():
                        if time.monotonic() >= next_cleanup:
                            self.queue.cleanup()
                            next_cleanup = time.monotonic() + CLEANUP_SECONDS
                        processed = self.queue.process_next(self.worker_id)
                        if processed:
                            continue
                        self.wake_event.clear()
                        self.wake_event.wait(self.poll_seconds)
            except Exception:
                logger.exception("Price upload queue worker loop failed.")
                self.stop_event.wait(max(1.0, self.poll_seconds))


_worker_lock = Lock()
_worker: PriceComparisonUploadWorker | None = None


def start_price_comparison_upload_worker() -> None:
    global _worker
    with _worker_lock:
        if _worker is None:
            _worker = PriceComparisonUploadWorker()
        worker = _worker
    worker.start()


async def stop_price_comparison_upload_worker() -> None:
    global _worker
    with _worker_lock:
        worker = _worker
        _worker = None
    if worker is not None:
        await asyncio.to_thread(worker.stop)


def wake_price_comparison_upload_worker() -> None:
    with _worker_lock:
        worker = _worker
    if worker is not None:
        worker.wake()
