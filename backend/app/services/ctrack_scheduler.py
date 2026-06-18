from __future__ import annotations

import asyncio
import os
import logging
from contextlib import suppress
from pathlib import Path
from tempfile import gettempdir

import fcntl

from app.core.config import settings
from app.core.database import SessionLocal
from app.services.ctrack_client import (
    CtrackConfigError,
    CtrackRequestError,
    CtrackVehicleSyncService,
)


CTRACK_SYNC_INTERVAL_SECONDS = 15 * 60
CTRACK_SYNC_INITIAL_DELAY_SECONDS = 45

logger = logging.getLogger(__name__)
_scheduler_task: asyncio.Task[None] | None = None
_scheduler_lock_handle = None
_scheduler_lock_path = Path(gettempdir()) / "kalender_beg_ctrack_scheduler.lock"


def start_ctrack_sync_scheduler(
    *,
    interval_seconds: int = CTRACK_SYNC_INTERVAL_SECONDS,
    initial_delay_seconds: int = CTRACK_SYNC_INITIAL_DELAY_SECONDS,
) -> None:
    global _scheduler_task
    if _scheduler_task is not None and not _scheduler_task.done():
        return
    config_issues = _ctrack_config_issues()
    if not settings.ctrack_sync_enabled or config_issues:
        logger.warning(
            "Ctrack-Sync deaktiviert oder unvollständig konfiguriert. enabled=%s missing_or_invalid=%s",
            settings.ctrack_sync_enabled,
            ", ".join(config_issues) if config_issues else "-",
        )
        return
    if not _acquire_scheduler_lock():
        logger.info("Ctrack sync scheduler skipped: another worker already owns the scheduler lock.")
        return

    _scheduler_task = asyncio.create_task(
        _ctrack_sync_loop(
            interval_seconds=interval_seconds,
            initial_delay_seconds=initial_delay_seconds,
        ),
        name="ctrack-sync-scheduler",
    )
    logger.info(
        "Ctrack sync scheduler started: interval_seconds=%s initial_delay_seconds=%s",
        interval_seconds,
        initial_delay_seconds,
    )


async def stop_ctrack_sync_scheduler() -> None:
    global _scheduler_task
    if _scheduler_task is None:
        _release_scheduler_lock()
        return

    _scheduler_task.cancel()
    with suppress(asyncio.CancelledError):
        await _scheduler_task
    _scheduler_task = None
    _release_scheduler_lock()
    logger.info("Ctrack sync scheduler stopped.")


async def _ctrack_sync_loop(
    *,
    interval_seconds: int,
    initial_delay_seconds: int,
) -> None:
    if initial_delay_seconds > 0:
        await asyncio.sleep(initial_delay_seconds)

    while True:
        await asyncio.to_thread(run_ctrack_sync_once)
        await asyncio.sleep(interval_seconds)


def run_ctrack_sync_once() -> dict[str, int] | None:
    config_issues = _ctrack_config_issues()
    if not settings.ctrack_sync_enabled or config_issues:
        logger.warning(
            "Ctrack-Sync deaktiviert oder unvollständig konfiguriert. enabled=%s missing_or_invalid=%s",
            settings.ctrack_sync_enabled,
            ", ".join(config_issues) if config_issues else "-",
        )
        return None
    try:
        with SessionLocal() as db:
            result = CtrackVehicleSyncService(db).sync_now()
    except CtrackConfigError as error:
        logger.warning(
            "Ctrack-Sync deaktiviert oder unvollständig konfiguriert. missing_or_invalid=%s",
            ", ".join(error.missing_config),
        )
        return None
    except CtrackRequestError as error:
        logger.warning(
            "Ctrack sync failed: status=%s url=%s message=%s",
            error.status_code,
            error.url or "-",
            str(error),
        )
        return None
    except Exception:
        logger.exception("Ctrack sync failed unexpectedly.")
        return None

    logger.info(
        "Ctrack sync completed: vehicles_received=%s vehicles_upserted=%s "
        "positions_received=%s positions_inserted=%s latest_positions_updated=%s "
        "vehicles_skipped=%s positions_skipped=%s",
        result["vehicles_received"],
        result["vehicles_upserted"],
        result["positions_received"],
        result["positions_inserted"],
        result["latest_positions_updated"],
        result["vehicles_skipped"],
        result["positions_skipped"],
    )
    return result


def _ctrack_config_issues() -> list[str]:
    issues: list[str] = []
    if not settings.ctrack_base_url:
        issues.append("CTRACK_BASE_URL")
    elif not settings.ctrack_base_url.startswith(("http://", "https://")):
        issues.append("CTRACK_BASE_URL")
    if not settings.ctrack_username:
        issues.append("CTRACK_USERNAME")
    if not settings.ctrack_password:
        issues.append("CTRACK_PASSWORD")
    return issues


def _acquire_scheduler_lock() -> bool:
    global _scheduler_lock_handle
    if _scheduler_lock_handle is not None:
        return True
    handle = _scheduler_lock_path.open("w", encoding="utf-8")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        handle.close()
        return False
    handle.write(str(os.getpid()))
    handle.flush()
    _scheduler_lock_handle = handle
    return True


def _release_scheduler_lock() -> None:
    global _scheduler_lock_handle
    if _scheduler_lock_handle is None:
        return
    with suppress(OSError):
        fcntl.flock(_scheduler_lock_handle.fileno(), fcntl.LOCK_UN)
    _scheduler_lock_handle.close()
    _scheduler_lock_handle = None
