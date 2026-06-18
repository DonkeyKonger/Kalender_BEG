from __future__ import annotations

import asyncio
import logging
from contextlib import suppress
from datetime import datetime
from zoneinfo import ZoneInfo

from app.core.config import settings
from app.core.database import SessionLocal
from app.services.push_notification_service import PushNotificationService


PUSH_PLAN_CHECK_INTERVAL_SECONDS = 60
PUSH_PLAN_SEND_HOUR = 15
BERLIN_TZ = ZoneInfo("Europe/Berlin")

logger = logging.getLogger(__name__)
_scheduler_task: asyncio.Task[None] | None = None


def start_push_plan_scheduler(
    *,
    interval_seconds: int = PUSH_PLAN_CHECK_INTERVAL_SECONDS,
) -> None:
    global _scheduler_task
    if not settings.push_plan_scheduler_enabled:
        logger.info("Push plan scheduler skipped because PUSH_PLAN_SCHEDULER_ENABLED is false.")
        return
    if _scheduler_task is not None and not _scheduler_task.done():
        return

    _scheduler_task = asyncio.create_task(
        _push_plan_loop(interval_seconds=interval_seconds),
        name="push-plan-scheduler",
    )
    logger.info("Push plan scheduler started: interval_seconds=%s", interval_seconds)


async def stop_push_plan_scheduler() -> None:
    global _scheduler_task
    if _scheduler_task is None:
        return

    _scheduler_task.cancel()
    with suppress(asyncio.CancelledError):
        await _scheduler_task
    _scheduler_task = None
    logger.info("Push plan scheduler stopped.")


async def _push_plan_loop(*, interval_seconds: int) -> None:
    last_run_date: str | None = None
    while True:
        now = datetime.now(BERLIN_TZ)
        today_key = now.date().isoformat()
        if now.hour >= PUSH_PLAN_SEND_HOUR and last_run_date != today_key:
            sent_count = await asyncio.to_thread(run_push_plan_notifications_once)
            last_run_date = today_key
            logger.info("Push plan scheduler run completed: sent_count=%s", sent_count)
        await asyncio.sleep(interval_seconds)


def run_push_plan_notifications_once() -> int:
    try:
        with SessionLocal() as db:
            return PushNotificationService(db).send_due_plan_change_notifications()
    except Exception:
        logger.exception("Push plan notification run failed unexpectedly.")
        return 0
