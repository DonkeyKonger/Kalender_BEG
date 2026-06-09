from __future__ import annotations

import asyncio
import logging
from contextlib import suppress

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


def start_ctrack_sync_scheduler(
    *,
    interval_seconds: int = CTRACK_SYNC_INTERVAL_SECONDS,
    initial_delay_seconds: int = CTRACK_SYNC_INITIAL_DELAY_SECONDS,
) -> None:
    global _scheduler_task
    if _scheduler_task is not None and not _scheduler_task.done():
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
        return

    _scheduler_task.cancel()
    with suppress(asyncio.CancelledError):
        await _scheduler_task
    _scheduler_task = None
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
    try:
        with SessionLocal() as db:
            result = CtrackVehicleSyncService(db).sync_now()
    except CtrackConfigError as error:
        logger.info(
            "Ctrack sync skipped: missing config (%s)",
            ", ".join(error.missing_config),
        )
        return None
    except CtrackRequestError:
        logger.exception("Ctrack sync failed: Ctrack request error.")
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
