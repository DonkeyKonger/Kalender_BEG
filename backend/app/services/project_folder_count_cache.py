import logging
from hashlib import sha256
from time import time
from uuid import uuid4

from fastapi import BackgroundTasks
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.database import SessionLocal
from app.models.project_folder import ProjectFolder
from app.models.project_folder_count import ProjectFolderCount
from app.services.project_storage_service import ProjectStorageService

LOGGER = logging.getLogger(__name__)
FRESH_SECONDS = 300
LEASE_SECONDS = 120
RETRY_SECONDS = 60


def cache_key(site_id: int, folder: ProjectFolder) -> str:
    # A new SharePoint binding must never reuse counts from the old tree.
    return sha256(repr((site_id, folder.folder_key, folder.external_drive_id, folder.external_item_id)).encode()).hexdigest()


def cached_counts(db: Session, site_id: int, folders: list[ProjectFolder]) -> dict[str, int | None]:
    keys = [cache_key(site_id, folder) for folder in folders]
    return {row.key: row.file_count for row in db.scalars(select(ProjectFolderCount).where(ProjectFolderCount.key.in_(keys)))} if keys else {}


def invalidate_site_counts(db: Session, site_id: int) -> None:
    # Keep the number, but fence out any in-flight result from before the write.
    db.execute(update(ProjectFolderCount).where(ProjectFolderCount.site_id == site_id).values(retry_after=0, token=None))


def read_and_refresh(db: Session, site_id: int, folder: ProjectFolder, background_tasks: BackgroundTasks) -> dict:
    if not folder.external_drive_id or not folder.external_item_id:
        return {"file_count": None, "refreshing": False}
    key = cache_key(site_id, folder)
    row = db.get(ProjectFolderCount, key)
    if row is None:
        try:
            with db.begin_nested():
                db.add(ProjectFolderCount(key=key, site_id=site_id, retry_after=0))
                db.flush()
        except IntegrityError:
            pass  # Another process initialized the same cache entry.
        row = db.get(ProjectFolderCount, key)
    now = time()
    token = str(uuid4())
    claimed = db.execute(update(ProjectFolderCount).where(
        ProjectFolderCount.key == key, ProjectFolderCount.retry_after <= now,
    ).values(token=token, retry_after=now + LEASE_SECONDS)).rowcount
    # The lease must be visible to all API workers before starting remote work.
    db.commit()
    db.refresh(row)
    result = {"file_count": row.file_count, "refreshing": bool(row.token)}
    if claimed:
        background_tasks.add_task(refresh_count, key, token, folder.external_drive_id, folder.external_item_id)
    return result


def refresh_count(key: str, token: str, drive_id: str, item_id: str) -> None:
    try:
        count = ProjectStorageService().count_folder_files(drive_id=drive_id, folder_item_id=item_id)
        values = {"file_count": count, "checked_at": time(), "retry_after": time() + FRESH_SECONDS, "token": None}
    except Exception:
        # Never replace a known count with zero or a partial total on failure.
        LOGGER.warning("Project folder count refresh failed for cache %s", key, exc_info=True)
        values = {"retry_after": time() + RETRY_SECONDS, "token": None}
    try:
        with SessionLocal() as db:
            db.execute(update(ProjectFolderCount).where(
                ProjectFolderCount.key == key, ProjectFolderCount.token == token,
            ).values(**values))
            db.commit()
    except Exception:
        LOGGER.exception("Could not persist project folder count %s", key)
