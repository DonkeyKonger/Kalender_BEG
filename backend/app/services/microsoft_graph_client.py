from __future__ import annotations

import base64
import json
import re
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlparse

import httpx

from app.core.config import settings

GRAPH_SCOPE = "https://graph.microsoft.com/.default"


class MicrosoftGraphConfigError(Exception):
    def __init__(self, missing_config: list[str]) -> None:
        self.missing_config = missing_config
        super().__init__("Missing Microsoft Graph configuration.")


class MicrosoftGraphRequestError(Exception):
    def __init__(
        self,
        status_code: int | None,
        message: str,
        *,
        error_code: str | None = None,
        error_message_short: str | None = None,
        diagnostics: dict[str, Any] | None = None,
    ) -> None:
        self.status_code = status_code
        self.error_code = error_code
        self.error_message_short = error_message_short
        self.diagnostics = diagnostics or {}
        super().__init__(message)


class MicrosoftGraphClient:
    def __init__(self, config=settings) -> None:
        self.config = config
        self._access_token: str | None = None
        self._access_token_expires_at: datetime | None = None
        self._token_audience: str | None = None
        self.last_request_diagnostics: dict[str, Any] = {}

    @property
    def token_audience(self) -> str | None:
        return self._token_audience

    def get_access_token(self) -> str:
        self._ensure_auth_config()
        if self._access_token and self._access_token_expires_at:
            if self._access_token_expires_at > datetime.now(UTC):
                return self._access_token

        token_url = (
            f"https://login.microsoftonline.com/{self.config.ms_tenant_id}"
            "/oauth2/v2.0/token"
        )
        payload = {
            "client_id": self.config.ms_client_id,
            "client_secret": self.config.ms_client_secret,
            "scope": GRAPH_SCOPE,
            "grant_type": "client_credentials",
        }
        try:
            response = httpx.post(
                token_url,
                data=payload,
                timeout=self.config.ms_graph_timeout_seconds,
            )
        except httpx.TimeoutException as error:
            raise MicrosoftGraphRequestError(None, "Microsoft Graph token request timed out.") from error
        except httpx.HTTPError as error:
            raise MicrosoftGraphRequestError(None, "Microsoft Graph token request failed.") from error

        data = _safe_json(response)
        if response.status_code >= 400:
            raise MicrosoftGraphRequestError(
                response.status_code,
                f"Microsoft Graph token request failed with status {response.status_code}.",
                error_code=_safe_error_code(data)
                or _safe_www_authenticate_error(response.headers.get("WWW-Authenticate")),
                error_message_short=_safe_error_message_short(data),
            )

        access_token = data.get("access_token")
        if not isinstance(access_token, str) or not access_token:
            raise MicrosoftGraphRequestError(response.status_code, "Microsoft Graph token missing.")
        expires_in = data.get("expires_in")
        ttl_seconds = int(expires_in) if isinstance(expires_in, int | float | str) else 3600
        self._access_token = access_token
        self._access_token_expires_at = datetime.now(UTC) + timedelta(seconds=max(ttl_seconds - 60, 60))
        self._token_audience = _safe_jwt_claim(access_token, "aud")
        return access_token

    def get(self, path: str) -> dict[str, Any]:
        return self._request("GET", path)

    def post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self._request("POST", path, payload=payload)

    def patch(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self._request("PATCH", path, payload=payload)

    def delete(self, path: str) -> dict[str, Any]:
        return self._request("DELETE", path)

    def get_content(self, path: str) -> tuple[bytes, str | None]:
        token = self.get_access_token()
        url = f"{self.config.ms_graph_base_url.rstrip('/')}/{path.lstrip('/')}"
        headers = {"Authorization": f"Bearer {token}", "Accept": "*/*"}
        self.last_request_diagnostics = _request_diagnostics(
            method="GET",
            url=url,
            headers=headers,
            graph_base_url=self.config.ms_graph_base_url,
        )
        try:
            response = httpx.get(
                url,
                headers=headers,
                timeout=self.config.ms_graph_timeout_seconds,
                follow_redirects=True,
            )
        except httpx.TimeoutException as error:
            raise MicrosoftGraphRequestError(
                None,
                "Microsoft Graph request timed out.",
                diagnostics=self.last_request_diagnostics,
            ) from error
        except httpx.HTTPError as error:
            raise MicrosoftGraphRequestError(
                None,
                "Microsoft Graph request failed.",
                diagnostics=self.last_request_diagnostics,
            ) from error

        if response.status_code >= 400:
            data = _safe_json(response)
            raise MicrosoftGraphRequestError(
                response.status_code,
                f"Microsoft Graph request failed with status {response.status_code}.",
                error_code=_safe_error_code(data)
                or _safe_www_authenticate_error(response.headers.get("WWW-Authenticate")),
                error_message_short=_safe_error_message_short(data),
                diagnostics=self.last_request_diagnostics,
            )
        return response.content, response.headers.get("content-type")

    def put_content(self, path: str, content: bytes, content_type: str | None = None) -> dict[str, Any]:
        token = self.get_access_token()
        url = f"{self.config.ms_graph_base_url.rstrip('/')}/{path.lstrip('/')}"
        headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
        if content_type:
            headers["Content-Type"] = content_type
        self.last_request_diagnostics = _request_diagnostics(
            method="PUT",
            url=url,
            headers=headers,
            graph_base_url=self.config.ms_graph_base_url,
        )
        try:
            response = httpx.put(
                url,
                content=content,
                headers=headers,
                timeout=self.config.ms_graph_timeout_seconds,
            )
        except httpx.TimeoutException as error:
            raise MicrosoftGraphRequestError(
                None,
                "Microsoft Graph request timed out.",
                diagnostics=self.last_request_diagnostics,
            ) from error
        except httpx.HTTPError as error:
            raise MicrosoftGraphRequestError(
                None,
                "Microsoft Graph request failed.",
                diagnostics=self.last_request_diagnostics,
            ) from error

        data = _safe_json(response)
        if response.status_code >= 400:
            raise MicrosoftGraphRequestError(
                response.status_code,
                f"Microsoft Graph request failed with status {response.status_code}.",
                error_code=_safe_error_code(data)
                or _safe_www_authenticate_error(response.headers.get("WWW-Authenticate")),
                error_message_short=_safe_error_message_short(data),
                diagnostics=self.last_request_diagnostics,
            )
        return data if isinstance(data, dict) else {}

    def _request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        token = self.get_access_token()
        url = f"{self.config.ms_graph_base_url.rstrip('/')}/{path.lstrip('/')}"
        headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
        if payload is not None:
            headers["Content-Type"] = "application/json"
        self.last_request_diagnostics = _request_diagnostics(
            method=method,
            url=url,
            headers=headers,
            graph_base_url=self.config.ms_graph_base_url,
        )
        try:
            response = httpx.request(
                method,
                url,
                json=payload,
                headers=headers,
                timeout=self.config.ms_graph_timeout_seconds,
            )
        except httpx.TimeoutException as error:
            raise MicrosoftGraphRequestError(
                None,
                "Microsoft Graph request timed out.",
                diagnostics=self.last_request_diagnostics,
            ) from error
        except httpx.HTTPError as error:
            raise MicrosoftGraphRequestError(
                None,
                "Microsoft Graph request failed.",
                diagnostics=self.last_request_diagnostics,
            ) from error

        data = _safe_json(response)
        if response.status_code >= 400:
            raise MicrosoftGraphRequestError(
                response.status_code,
                f"Microsoft Graph request failed with status {response.status_code}.",
                error_code=_safe_error_code(data)
                or _safe_www_authenticate_error(response.headers.get("WWW-Authenticate")),
                error_message_short=_safe_error_message_short(data),
                diagnostics=self.last_request_diagnostics,
            )
        if response.status_code == 204 or not response.content:
            return {}
        return data if isinstance(data, dict) else {"value": data}

    def _ensure_auth_config(self) -> None:
        missing = [
            name
            for name, value in {
                "MS_TENANT_ID": self.config.ms_tenant_id,
                "MS_CLIENT_ID": self.config.ms_client_id,
                "MS_CLIENT_SECRET": self.config.ms_client_secret,
            }.items()
            if not value
        ]
        if missing:
            raise MicrosoftGraphConfigError(missing)


def _safe_json(response: httpx.Response) -> dict[str, Any]:
    try:
        data = response.json()
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


def _safe_error_code(data: dict[str, Any]) -> str | None:
    error = data.get("error")
    if isinstance(error, str):
        return error
    if isinstance(error, dict):
        code = error.get("code")
        if isinstance(code, str):
            return code
    return None


def _safe_error_message_short(data: dict[str, Any]) -> str | None:
    error = data.get("error")
    if not isinstance(error, dict):
        return None
    message = error.get("message")
    if not isinstance(message, str):
        return None
    normalized = " ".join(message.split())
    if not normalized:
        return None
    lowered = normalized.lower()
    if "bearer " in lowered or "client_secret" in lowered or "authorization:" in lowered:
        return None
    if "eyj" in lowered:
        return None
    return normalized[:180]


def _safe_www_authenticate_error(header: str | None) -> str | None:
    if not header:
        return None
    match = re.search(r'error="?([^",\s]+)"?', header)
    return match.group(1) if match else None


def _safe_jwt_claim(token: str, claim: str) -> str | None:
    parts = token.split(".")
    if len(parts) < 2:
        return None
    payload = parts[1] + "=" * (-len(parts[1]) % 4)
    try:
        decoded = base64.urlsafe_b64decode(payload.encode("ascii"))
        data = json.loads(decoded.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    value = data.get(claim) if isinstance(data, dict) else None
    return value if isinstance(value, str) else None


def _request_diagnostics(
    *,
    method: str,
    url: str,
    headers: dict[str, str],
    graph_base_url: str,
) -> dict[str, Any]:
    authorization = headers.get("Authorization")
    scheme = authorization.split(" ", 1)[0] if authorization else None
    base_url = graph_base_url.rstrip("/")
    return {
        "authorization_header_present": bool(authorization),
        "authorization_header_scheme": scheme,
        "graph_base_url_used": base_url,
        "drive_url_shape": _safe_drive_url_shape(method, url, base_url),
    }


def _safe_drive_url_shape(method: str, url: str, graph_base_url: str) -> str | None:
    path = urlparse(url).path
    if re.fullmatch(r"/v1\.0/drives/[^/]+", path):
        return f"{method} {graph_base_url}/drives/{{drive_id}}"
    if re.fullmatch(r"/v1\.0/drives/[^/]+/items/[^/]+", path):
        return f"{method} {graph_base_url}/drives/{{drive_id}}/items/{{item_id}}"
    return None
