from types import SimpleNamespace

import httpx
import pytest

from app.services.microsoft_graph_client import GRAPH_SCOPE, MicrosoftGraphClient, MicrosoftGraphRequestError


def graph_config(**overrides):
    defaults = {
        "ms_tenant_id": "tenant-1",
        "ms_client_id": "client-1",
        "ms_client_secret": "super-secret-value",
        "ms_graph_timeout_seconds": 15.0,
        "ms_graph_base_url": "https://graph.microsoft.com/v1.0",
    }
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def test_graph_client_uses_graph_default_scope_and_bearer_header(monkeypatch):
    captured = {}

    def fake_post(url, data, timeout):
        captured["token_url"] = url
        captured["token_payload"] = data
        captured["token_timeout"] = timeout
        return httpx.Response(200, json={"access_token": "graph-token", "expires_in": 3600})

    def fake_request(method, url, json, headers, timeout):
        captured["method"] = method
        captured["url"] = url
        captured["headers"] = headers
        captured["timeout"] = timeout
        return httpx.Response(200, json={"id": "drive-1", "name": "Dokumente"})

    monkeypatch.setattr(httpx, "post", fake_post)
    monkeypatch.setattr(httpx, "request", fake_request)

    result = MicrosoftGraphClient(config=graph_config()).get("/drives/drive-1")

    assert captured["token_url"] == "https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token"
    assert captured["token_payload"]["scope"] == GRAPH_SCOPE
    assert captured["token_payload"]["scope"] == "https://graph.microsoft.com/.default"
    assert captured["url"] == "https://graph.microsoft.com/v1.0/drives/drive-1"
    assert captured["headers"]["Authorization"] == "Bearer graph-token"
    assert result == {"id": "drive-1", "name": "Dokumente"}
    assert "graph-token" not in str(result)
    assert "super-secret-value" not in str(result)


def test_graph_client_safely_reports_www_authenticate_error_without_token(monkeypatch):
    def fake_post(url, data, timeout):
        return httpx.Response(200, json={"access_token": "graph-token", "expires_in": 3600})

    def fake_request(method, url, json, headers, timeout):
        return httpx.Response(
            401,
            json={},
            headers={
                "WWW-Authenticate": 'Bearer error="invalid_token", error_description="token detail must stay hidden"'
            },
        )

    monkeypatch.setattr(httpx, "post", fake_post)
    monkeypatch.setattr(httpx, "request", fake_request)

    with pytest.raises(MicrosoftGraphRequestError) as error:
        MicrosoftGraphClient(config=graph_config()).get("/drives/drive-1")

    assert error.value.status_code == 401
    assert error.value.error_code == "invalid_token"
    assert "graph-token" not in str(error.value)
    assert "super-secret-value" not in str(error.value)
    assert "token detail must stay hidden" not in str(error.value)
