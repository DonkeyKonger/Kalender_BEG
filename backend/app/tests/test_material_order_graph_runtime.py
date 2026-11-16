import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
import json
from threading import Lock
from time import sleep
from types import SimpleNamespace

import httpx
import pytest

from app.services.material_order_graph_runtime import (
    MaterialOrderGraphRuntime,
    close_material_order_graph_runtime,
    get_material_order_storage_service,
)
from app.services.microsoft_graph_client import (
    MicrosoftGraphClient,
    MicrosoftGraphRequestError,
)


def graph_config(**overrides):
    defaults = {
        "ms_tenant_id": "tenant-1",
        "ms_client_id": "client-1",
        "ms_client_secret": "secret-1",
        "ms_graph_timeout_seconds": 15.0,
        "ms_graph_base_url": "https://graph.microsoft.com/v1.0",
    }
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def fake_jwt(payload: dict[str, object]) -> str:
    def encode(value: dict[str, object]) -> str:
        raw = json.dumps(value, separators=(",", ":")).encode()
        return base64.urlsafe_b64encode(raw).decode().rstrip("=")

    return f"{encode({'alg': 'none'})}.{encode(payload)}.signature"


def test_runtime_shares_token_and_pool_but_keeps_request_diagnostics_local():
    token_calls = 0
    access_token = fake_jwt({"aud": "https://graph.microsoft.com"})

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal token_calls
        if request.url.host == "login.microsoftonline.com":
            token_calls += 1
            return httpx.Response(
                200,
                json={"access_token": access_token, "expires_in": 3600},
            )
        return httpx.Response(200, json={"id": request.url.path})

    runtime = MaterialOrderGraphRuntime(
        config=graph_config(),
        transport=httpx.MockTransport(handler),
    )
    first = runtime.storage_service().graph_client
    second = runtime.storage_service().graph_client

    first.get("/drives/drive-1")
    first_diagnostics = dict(first.last_request_diagnostics)
    second.get("/me")

    assert first is not second
    assert token_calls == 1
    assert first.last_request_diagnostics == first_diagnostics
    assert first_diagnostics["drive_url_shape"] == (
        "GET https://graph.microsoft.com/v1.0/drives/{drive_id}"
    )
    assert second.last_request_diagnostics["drive_url_shape"] is None

    runtime.close()
    assert runtime.is_closed is True
    assert runtime.http_client.is_closed is True
    runtime.close()


def test_runtime_refreshes_expired_shared_token():
    token_calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal token_calls
        assert request.url.host == "login.microsoftonline.com"
        token_calls += 1
        return httpx.Response(
            200,
            json={
                "access_token": fake_jwt(
                    {"aud": "https://graph.microsoft.com", "sequence": token_calls}
                ),
                "expires_in": 3600,
            },
        )

    runtime = MaterialOrderGraphRuntime(
        config=graph_config(),
        transport=httpx.MockTransport(handler),
    )
    first = runtime.storage_service().graph_client.get_access_token()
    runtime.token_provider._access_token_expires_at = datetime.now(UTC) - timedelta(
        seconds=1
    )
    second = runtime.storage_service().graph_client.get_access_token()

    assert first != second
    assert token_calls == 2
    runtime.close()


def test_runtime_short_token_ttl_never_caches_past_provider_expiry():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.host == "login.microsoftonline.com"
        return httpx.Response(
            200,
            json={
                "access_token": fake_jwt({"aud": "https://graph.microsoft.com"}),
                "expires_in": 30,
            },
        )

    runtime = MaterialOrderGraphRuntime(
        config=graph_config(),
        transport=httpx.MockTransport(handler),
    )
    requested_at = datetime.now(UTC)
    runtime.storage_service().graph_client.get_access_token()
    cached_for = runtime.token_provider._access_token_expires_at - requested_at

    assert timedelta(seconds=26) < cached_for <= timedelta(seconds=27.5)
    runtime.close()


def test_runtime_serializes_parallel_token_refreshes():
    token_calls = 0
    call_lock = Lock()
    access_token = fake_jwt({"aud": "https://graph.microsoft.com"})

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal token_calls
        assert request.url.host == "login.microsoftonline.com"
        with call_lock:
            token_calls += 1
        sleep(0.05)
        return httpx.Response(
            200,
            json={"access_token": access_token, "expires_in": 3600},
        )

    runtime = MaterialOrderGraphRuntime(
        config=graph_config(),
        transport=httpx.MockTransport(handler),
    )
    clients = [runtime.storage_service().graph_client for _ in range(3)]
    with ThreadPoolExecutor(max_workers=3) as executor:
        tokens = list(executor.map(lambda client: client.get_access_token(), clients))

    assert tokens == [access_token, access_token, access_token]
    assert token_calls == 1
    runtime.close()


def test_runtime_invalidates_shared_token_after_401_without_replaying_request():
    token_calls = 0
    graph_calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal graph_calls, token_calls
        if request.url.host == "login.microsoftonline.com":
            token_calls += 1
            return httpx.Response(
                200,
                json={
                    "access_token": fake_jwt(
                        {"aud": "https://graph.microsoft.com", "sequence": token_calls}
                    ),
                    "expires_in": 3600,
                },
            )
        graph_calls += 1
        if graph_calls == 1:
            return httpx.Response(401, json={"error": {"code": "InvalidAuthenticationToken"}})
        return httpx.Response(200, json={"id": "drive-1"})

    runtime = MaterialOrderGraphRuntime(
        config=graph_config(),
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(MicrosoftGraphRequestError) as error:
        runtime.storage_service().graph_client.get("/drives/drive-1")
    assert error.value.status_code == 401
    assert graph_calls == 1

    result = runtime.storage_service().graph_client.get("/drives/drive-1")

    assert result == {"id": "drive-1"}
    assert token_calls == 2
    assert graph_calls == 2
    runtime.close()


def test_runtime_does_not_invalidate_shared_token_after_403():
    token_calls = 0
    graph_calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal graph_calls, token_calls
        if request.url.host == "login.microsoftonline.com":
            token_calls += 1
            return httpx.Response(
                200,
                json={
                    "access_token": fake_jwt({"aud": "https://graph.microsoft.com"}),
                    "expires_in": 3600,
                },
            )
        graph_calls += 1
        status_code = 403 if graph_calls == 1 else 200
        return httpx.Response(status_code, json={"id": "drive-1"})

    runtime = MaterialOrderGraphRuntime(
        config=graph_config(),
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(MicrosoftGraphRequestError) as error:
        runtime.storage_service().graph_client.get("/drives/drive-1")
    assert error.value.status_code == 403

    runtime.storage_service().graph_client.get("/drives/drive-1")

    assert token_calls == 1
    runtime.close()


@pytest.mark.parametrize(
    "overrides",
    [
        {"ms_client_id": "other-client"},
        {"ms_graph_base_url": "https://example.invalid/v1.0"},
    ],
)
def test_runtime_rejects_a_client_with_different_configuration(overrides):
    runtime = MaterialOrderGraphRuntime(
        config=graph_config(),
        transport=httpx.MockTransport(lambda _request: httpx.Response(200)),
    )

    with pytest.raises(ValueError, match="configuration mismatch"):
        MicrosoftGraphClient(
            config=graph_config(**overrides),
            http_client=runtime.http_client,
            token_provider=runtime.token_provider,
        )

    runtime.close()


def test_process_runtime_close_releases_pool_and_allows_clean_recreation():
    close_material_order_graph_runtime()
    first_client = get_material_order_storage_service().graph_client._http_client

    close_material_order_graph_runtime()

    assert first_client is not None
    assert first_client.is_closed is True
    second_client = get_material_order_storage_service().graph_client._http_client
    assert second_client is not first_client
    assert second_client is not None
    assert second_client.is_closed is False
    close_material_order_graph_runtime()
