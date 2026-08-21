from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from time import perf_counter
from typing import Any, Protocol

from fastapi import HTTPException


MAX_PARALLEL_PHOTO_DOWNLOADS = 3


class PhotoStorage(Protocol):
    def download_file_from_folder(
        self,
        *,
        drive_id: str | None,
        folder_item_id: str | None,
        item_id: str,
    ) -> dict[str, Any]: ...


@dataclass(frozen=True)
class PhotoDownloadRequest:
    drive_id: str | None
    folder_item_id: str | None
    item_id: str


@dataclass(frozen=True)
class PhotoDownloadResult:
    request: PhotoDownloadRequest
    content: bytes
    duration_ms: float
    error: Exception | None = None


def download_photo_files(
    storage: PhotoStorage,
    requests: list[PhotoDownloadRequest] | tuple[PhotoDownloadRequest, ...],
) -> tuple[PhotoDownloadResult, ...]:
    ordered_requests = tuple(requests)
    if not ordered_requests:
        return ()
    if len(ordered_requests) == 1:
        return (_download_photo_file(storage, ordered_requests[0]),)

    worker_count = min(MAX_PARALLEL_PHOTO_DOWNLOADS, len(ordered_requests))
    with ThreadPoolExecutor(
        max_workers=worker_count,
        thread_name_prefix="photo-download",
    ) as executor:
        return tuple(
            executor.map(
                lambda request: _download_photo_file(storage, request),
                ordered_requests,
            )
        )


def _download_photo_file(
    storage: PhotoStorage,
    request: PhotoDownloadRequest,
) -> PhotoDownloadResult:
    started_at = perf_counter()
    try:
        downloaded = storage.download_file_from_folder(
            drive_id=request.drive_id,
            folder_item_id=request.folder_item_id,
            item_id=request.item_id,
        )
        content = bytes(downloaded["content"])
    except (HTTPException, KeyError, OSError, TypeError, ValueError) as error:
        return PhotoDownloadResult(
            request=request,
            content=b"",
            duration_ms=(perf_counter() - started_at) * 1000,
            error=error,
        )
    return PhotoDownloadResult(
        request=request,
        content=content,
        duration_ms=(perf_counter() - started_at) * 1000,
    )
