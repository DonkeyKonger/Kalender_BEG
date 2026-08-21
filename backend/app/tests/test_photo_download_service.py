from threading import Lock
from time import perf_counter, sleep

from app.services.photo_download_service import (
    MAX_PARALLEL_PHOTO_DOWNLOADS,
    PhotoDownloadRequest,
    download_photo_files,
)


def _requests(count: int) -> list[PhotoDownloadRequest]:
    return [
        PhotoDownloadRequest(
            drive_id="drive-1",
            folder_item_id="folder-1",
            item_id=f"photo-{index}",
        )
        for index in range(count)
    ]


def test_photo_downloads_overlap_network_latency_with_bounded_parallelism():
    class DelayedStorage:
        def __init__(self) -> None:
            self.lock = Lock()
            self.active = 0
            self.maximum_active = 0

        def download_file_from_folder(self, **kwargs):
            with self.lock:
                self.active += 1
                self.maximum_active = max(self.maximum_active, self.active)
            sleep(0.08)
            with self.lock:
                self.active -= 1
            return {"content": kwargs["item_id"].encode()}

    storage = DelayedStorage()
    started_at = perf_counter()
    results = download_photo_files(storage, _requests(5))
    duration = perf_counter() - started_at

    assert MAX_PARALLEL_PHOTO_DOWNLOADS == 3
    assert storage.maximum_active == 3
    assert duration < 0.32
    assert [result.content for result in results] == [
        b"photo-0",
        b"photo-1",
        b"photo-2",
        b"photo-3",
        b"photo-4",
    ]


def test_photo_download_error_keeps_order_and_returns_empty_content():
    class PartiallyFailingStorage:
        def download_file_from_folder(self, **kwargs):
            if kwargs["item_id"] == "photo-1":
                raise ValueError("download failed")
            return {"content": kwargs["item_id"].encode()}

    results = download_photo_files(PartiallyFailingStorage(), _requests(3))

    assert [result.request.item_id for result in results] == ["photo-0", "photo-1", "photo-2"]
    assert results[0].content == b"photo-0"
    assert results[1].content == b""
    assert isinstance(results[1].error, ValueError)
    assert results[2].content == b"photo-2"
