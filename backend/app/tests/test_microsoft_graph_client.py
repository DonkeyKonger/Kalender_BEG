import base64
import json
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


def fake_jwt(payload: dict[str, object]) -> str:
    def encode(value: dict[str, object]) -> str:
        raw = json.dumps(value, separators=(",", ":")).encode("utf-8")
        return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")

    return f"{encode({'alg': 'none'})}.{encode(payload)}.signature"


def test_graph_client_uses_graph_default_scope_and_bearer_header(monkeypatch):
    captured = {}
    access_token = fake_jwt({"aud": "https://graph.microsoft.com", "roles": ["Files.Read.All"]})

    def fake_post(url, data, timeout):
        captured["token_url"] = url
        captured["token_payload"] = data
        captured["token_timeout"] = timeout
        return httpx.Response(200, json={"access_token": access_token, "expires_in": 3600})

    def fake_request(method, url, json, headers, timeout):
        captured["method"] = method
        captured["url"] = url
        captured["headers"] = headers
        captured["timeout"] = timeout
        return httpx.Response(200, json={"id": "drive-1", "name": "Dokumente"})

    monkeypatch.setattr(httpx, "post", fake_post)
    monkeypatch.setattr(httpx, "request", fake_request)

    client = MicrosoftGraphClient(config=graph_config())
    result = client.get("/drives/drive-1")

    assert captured["token_url"] == "https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token"
    assert captured["token_payload"]["scope"] == GRAPH_SCOPE
    assert captured["token_payload"]["scope"] == "https://graph.microsoft.com/.default"
    assert captured["url"] == "https://graph.microsoft.com/v1.0/drives/drive-1"
    assert captured["headers"]["Authorization"] == f"Bearer {access_token}"
    assert client.token_audience == "https://graph.microsoft.com"
    assert client.last_request_diagnostics["authorization_header_present"] is True
    assert client.last_request_diagnostics["authorization_header_scheme"] == "Bearer"
    assert client.last_request_diagnostics["graph_base_url_used"] == "https://graph.microsoft.com/v1.0"
    assert client.last_request_diagnostics["drive_url_shape"] == "GET https://graph.microsoft.com/v1.0/drives/{drive_id}"
    assert result == {"id": "drive-1", "name": "Dokumente"}
    assert access_token not in str(result)
    assert "super-secret-value" not in str(result)


def test_graph_client_safely_reports_www_authenticate_error_without_token(monkeypatch):
    access_token = fake_jwt({"aud": "https://graph.microsoft.com"})

    def fake_post(url, data, timeout):
        return httpx.Response(200, json={"access_token": access_token, "expires_in": 3600})

    def fake_request(method, url, json, headers, timeout):
        return httpx.Response(
            401,
            json={"error": {"code": "generalException", "message": "Drive request was unauthorized."}},
            headers={
                "WWW-Authenticate": 'Bearer error="invalid_token", error_description="token detail must stay hidden"'
            },
        )

    monkeypatch.setattr(httpx, "post", fake_post)
    monkeypatch.setattr(httpx, "request", fake_request)

    with pytest.raises(MicrosoftGraphRequestError) as error:
        MicrosoftGraphClient(config=graph_config()).get("/drives/drive-1")

    assert error.value.status_code == 401
    assert error.value.error_code == "generalException"
    assert error.value.error_message_short == "Drive request was unauthorized."
    assert error.value.diagnostics["authorization_header_present"] is True
    assert error.value.diagnostics["authorization_header_scheme"] == "Bearer"
    assert error.value.diagnostics["drive_url_shape"] == "GET https://graph.microsoft.com/v1.0/drives/{drive_id}"
    assert access_token not in str(error.value)
    assert "super-secret-value" not in str(error.value)
    assert "token detail must stay hidden" not in str(error.value)
