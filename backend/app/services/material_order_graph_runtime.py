from __future__ import annotations

from threading import Lock

import httpx

from app.core.config import settings
from app.services.microsoft_graph_client import (
    MicrosoftGraphClient,
    MicrosoftGraphTokenProvider,
)
from app.services.project_storage_service import ProjectStorageService


class MaterialOrderGraphRuntime:
    """Process-scoped HTTP pool and token cache for material-order uploads only."""

    def __init__(
        self,
        *,
        config=settings,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.config = config
        self.http_client = httpx.Client(transport=transport)
        self.token_provider = MicrosoftGraphTokenProvider(
            config=config,
            http_client=self.http_client,
        )
        self._closed = False

    @property
    def is_closed(self) -> bool:
        return self._closed

    def storage_service(self) -> ProjectStorageService:
        if self._closed:
            raise RuntimeError("Material-order Graph runtime is closed.")
        graph_client = MicrosoftGraphClient(
            config=self.config,
            http_client=self.http_client,
            token_provider=self.token_provider,
        )
        return ProjectStorageService(graph_client=graph_client, config=self.config)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self.http_client.close()


_RUNTIME_LOCK = Lock()
_runtime: MaterialOrderGraphRuntime | None = None


def get_material_order_storage_service() -> ProjectStorageService:
    global _runtime
    with _RUNTIME_LOCK:
        if _runtime is None or _runtime.is_closed:
            _runtime = MaterialOrderGraphRuntime()
        runtime = _runtime
    return runtime.storage_service()


def close_material_order_graph_runtime() -> None:
    global _runtime
    with _RUNTIME_LOCK:
        runtime = _runtime
        _runtime = None
    if runtime is not None:
        runtime.close()
