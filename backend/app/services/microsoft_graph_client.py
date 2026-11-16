from __future__ import annotations

import base64
import json
import re
from datetime import UTC, datetime, timedelta
from threading import Lock
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


class MicrosoftGraphTokenProvider:
    """Thread-safe token cache bound to one immutable Graph configuration."""

    def __init__(self, *, config, http_client: httpx.Client) -> None:
        self.config = config
        self.http_client = http_client
        self._config_key = _token_config_key(config)
        self._access_token: str | None = None
        self._access_token_expires_at: datetime | None = None
        self._access_token_lock = Lock()
        self._token_audience: str | None = None

    @property
    def token_audience(self) -> str | None:
        return self._token_audience

    def ensure_compatible(self, config) -> None:
        if _token_config_key(config) != self._config_key:
            raise ValueError("Microsoft Graph token provider configuration mismatch.")

    def get_access_token(self, config) -> str:
        self.ensure_compatible(config)
        _ensure_auth_config(config)
        cached = self._valid_cached_access_token()
        if cached:
            return cached
        with self._access_token_lock:
            cached = self._valid_cached_access_token()
            if cached:
                return cached
            return self._request_access_token()

    def invalidate(self, access_token: str) -> None:
        """Drop only the still-current token after a confirmed 401 response."""

        with self._access_token_lock:
            if self._access_token != access_token:
                return
            self._access_token = None
            self._access_token_expires_at = None
            self._token_audience = None

    def _valid_cached_access_token(self) -> str | None:
        access_token = self._access_token
        expires_at = self._access_token_expires_at
        if access_token and expires_at and expires_at > datetime.now(UTC):
            return access_token
        return None

    def _request_access_token(self) -> str:
        token_url = (
            f"https://login.microsoftonline.com/{self.config.ms_tenant_id}"
            "/oauth2/v2.0/token"
        )
        payload = _token_request_payload(self.config)
        try:
            response = self.http_client.post(
                token_url,
                data=payload,
                timeout=self.config.ms_graph_timeout_seconds,
            )
        except httpx.TimeoutException as error:
            raise MicrosoftGraphRequestError(
                None, "Microsoft Graph token request timed out."
            ) from error
        except httpx.HTTPError as error:
            raise MicrosoftGraphRequestError(
                None, "Microsoft Graph token request failed."
            ) from error

        access_token, expires_at, token_audience = _parse_access_token_response(response)
        self._access_token = access_token
        self._access_token_expires_at = expires_at
        self._token_audience = token_audience
        return access_token


class MicrosoftGraphClient:
    def __init__(
        self,
        config=settings,
        *,
        http_client: httpx.Client | None = None,
        token_provider: MicrosoftGraphTokenProvider | None = None,
    ) -> None:
        self.config = config
        self._http_client = http_client
        self._token_provider = token_provider
        if token_provider is not None:
            if http_client is None:
                raise ValueError("A shared token provider requires an HTTP client.")
            token_provider.ensure_compatible(config)
            if token_provider.http_client is not http_client:
                raise ValueError(
                    "A shared token provider requires its configured HTTP client."
                )
        self._access_token: str | None = None
        self._access_token_expires_at: datetime | None = None
        self._access_token_lock = Lock()
        self._token_audience: str | None = None
        self.last_request_diagnostics: dict[str, Any] = {}

    @property
    def token_audience(self) -> str | None:
        if self._token_provider is not None:
            return self._token_provider.token_audience
        return self._token_audience

    def get_access_token(self) -> str:
        if self._token_provider is not None:
            return self._token_provider.get_access_token(self.config)
        self._ensure_auth_config()
        cached = self._valid_cached_access_token()
        if cached:
            return cached
        with self._access_token_lock:
            cached = self._valid_cached_access_token()
            if cached:
                return cached
            return self._request_access_token()

    def _valid_cached_access_token(self) -> str | None:
        access_token = self._access_token
        expires_at = self._access_token_expires_at
        if access_token and expires_at and expires_at > datetime.now(UTC):
            return access_token
        return None

    def _request_access_token(self) -> str:
        token_url = (
            f"https://login.microsoftonline.com/{self.config.ms_tenant_id}"
            "/oauth2/v2.0/token"
        )
        payload = _token_request_payload(self.config)
        try:
            request = self._http_client.post if self._http_client is not None else httpx.post
            response = request(
                token_url,
                data=payload,
                timeout=self.config.ms_graph_timeout_seconds,
            )
        except httpx.TimeoutException as error:
            raise MicrosoftGraphRequestError(None, "Microsoft Graph token request timed out.") from error
        except httpx.HTTPError as error:
            raise MicrosoftGraphRequestError(None, "Microsoft Graph token request failed.") from error

        access_token, expires_at, token_audience = _parse_access_token_response(response)
        self._access_token = access_token
        self._access_token_expires_at = expires_at
        self._token_audience = token_audience
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
        diagnostics = _request_diagnostics(
            method="GET",
            url=url,
            headers=headers,
            graph_base_url=self.config.ms_graph_base_url,
        )
        self.last_request_diagnostics = diagnostics
        try:
            request = self._http_client.get if self._http_client is not None else httpx.get
            response = request(
                url,
                headers=headers,
                timeout=self.config.ms_graph_timeout_seconds,
                follow_redirects=True,
            )
        except httpx.TimeoutException as error:
            raise MicrosoftGraphRequestError(
                None,
                "Microsoft Graph request timed out.",
                diagnostics=diagnostics,
            ) from error
        except httpx.HTTPError as error:
            raise MicrosoftGraphRequestError(
                None,
                "Microsoft Graph request failed.",
                diagnostics=diagnostics,
            ) from error

        if response.status_code >= 400:
            self._invalidate_shared_token_on_unauthorized(response, token)
            data = _safe_json(response)
            raise MicrosoftGraphRequestError(
                response.status_code,
                f"Microsoft Graph request failed with status {response.status_code}.",
                error_code=_safe_error_code(data)
                or _safe_www_authenticate_error(response.headers.get("WWW-Authenticate")),
                error_message_short=_safe_error_message_short(data),
                diagnostics=diagnostics,
            )
        return response.content, response.headers.get("content-type")

    def put_content(self, path: str, content: bytes, content_type: str | None = None) -> dict[str, Any]:
        token = self.get_access_token()
        url = f"{self.config.ms_graph_base_url.rstrip('/')}/{path.lstrip('/')}"
        headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
        if content_type:
            headers["Content-Type"] = content_type
        diagnostics = _request_diagnostics(
            method="PUT",
            url=url,
            headers=headers,
            graph_base_url=self.config.ms_graph_base_url,
        )
        self.last_request_diagnostics = diagnostics
        try:
            request = self._http_client.put if self._http_client is not None else httpx.put
            response = request(
                url,
                content=content,
                headers=headers,
                timeout=self.config.ms_graph_timeout_seconds,
            )
        except httpx.TimeoutException as error:
            raise MicrosoftGraphRequestError(
                None,
                "Microsoft Graph request timed out.",
                diagnostics=diagnostics,
            ) from error
        except httpx.HTTPError as error:
            raise MicrosoftGraphRequestError(
                None,
                "Microsoft Graph request failed.",
                diagnostics=diagnostics,
            ) from error

        data = _safe_json(response)
        if response.status_code >= 400:
            self._invalidate_shared_token_on_unauthorized(response, token)
            raise MicrosoftGraphRequestError(
                response.status_code,
                f"Microsoft Graph request failed with status {response.status_code}.",
                error_code=_safe_error_code(data)
                or _safe_www_authenticate_error(response.headers.get("WWW-Authenticate")),
                error_message_short=_safe_error_message_short(data),
                diagnostics=diagnostics,
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
        diagnostics = _request_diagnostics(
            method=method,
            url=url,
            headers=headers,
            graph_base_url=self.config.ms_graph_base_url,
        )
        self.last_request_diagnostics = diagnostics
        try:
            request = (
                self._http_client.request
                if self._http_client is not None
                else httpx.request
            )
            response = request(
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
                diagnostics=diagnostics,
            ) from error
        except httpx.HTTPError as error:
            raise MicrosoftGraphRequestError(
                None,
                "Microsoft Graph request failed.",
                diagnostics=diagnostics,
            ) from error

        data = _safe_json(response)
        if response.status_code >= 400:
            self._invalidate_shared_token_on_unauthorized(response, token)
            raise MicrosoftGraphRequestError(
                response.status_code,
                f"Microsoft Graph request failed with status {response.status_code}.",
                error_code=_safe_error_code(data)
                or _safe_www_authenticate_error(response.headers.get("WWW-Authenticate")),
                error_message_short=_safe_error_message_short(data),
                diagnostics=diagnostics,
            )
        if response.status_code == 204 or not response.content:
            return {}
        return data if isinstance(data, dict) else {"value": data}

    def _ensure_auth_config(self) -> None:
        _ensure_auth_config(self.config)

    def _invalidate_shared_token_on_unauthorized(
        self,
        response: httpx.Response,
        access_token: str,
    ) -> None:
        if response.status_code == 401 and self._token_provider is not None:
            self._token_provider.invalidate(access_token)


def _token_config_key(config) -> tuple[object, ...]:
    return (
        config.ms_tenant_id,
        config.ms_client_id,
        config.ms_client_secret,
        config.ms_graph_timeout_seconds,
        config.ms_graph_base_url.rstrip("/"),
    )


def _ensure_auth_config(config) -> None:
    missing = [
        name
        for name, value in {
            "MS_TENANT_ID": config.ms_tenant_id,
            "MS_CLIENT_ID": config.ms_client_id,
            "MS_CLIENT_SECRET": config.ms_client_secret,
        }.items()
        if not value
    ]
    if missing:
        raise MicrosoftGraphConfigError(missing)


def _token_request_payload(config) -> dict[str, str]:
    return {
        "client_id": config.ms_client_id,
        "client_secret": config.ms_client_secret,
        "scope": GRAPH_SCOPE,
        "grant_type": "client_credentials",
    }


def _parse_access_token_response(
    response: httpx.Response,
) -> tuple[str, datetime, str | None]:
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
        raise MicrosoftGraphRequestError(
            response.status_code, "Microsoft Graph token missing."
        )
    expires_in = data.get("expires_in")
    ttl_seconds = (
        int(expires_in) if isinstance(expires_in, int | float | str) else 3600
    )
    ttl_seconds = max(ttl_seconds, 0)
    refresh_margin = min(60.0, ttl_seconds / 10)
    expires_at = datetime.now(UTC) + timedelta(
        seconds=max(ttl_seconds - refresh_margin, 0)
    )
    return access_token, expires_at, _safe_jwt_claim(access_token, "aud")


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
