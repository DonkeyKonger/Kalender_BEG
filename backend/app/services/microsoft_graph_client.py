from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import httpx

from app.core.config import settings

GRAPH_SCOPE = "https://graph.microsoft.com/.default"


class MicrosoftGraphConfigError(Exception):
    def __init__(self, missing_config: list[str]) -> None:
        self.missing_config = missing_config
        super().__init__("Missing Microsoft Graph configuration.")


class MicrosoftGraphRequestError(Exception):
    def __init__(self, status_code: int | None, message: str) -> None:
        self.status_code = status_code
        super().__init__(message)


class MicrosoftGraphClient:
    def __init__(self, config=settings) -> None:
        self.config = config
        self._access_token: str | None = None
        self._access_token_expires_at: datetime | None = None

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

        if response.status_code >= 400:
            raise MicrosoftGraphRequestError(
                response.status_code,
                f"Microsoft Graph token request failed with status {response.status_code}.",
            )

        data = response.json()
        access_token = data.get("access_token")
        if not isinstance(access_token, str) or not access_token:
            raise MicrosoftGraphRequestError(response.status_code, "Microsoft Graph token missing.")
        expires_in = data.get("expires_in")
        ttl_seconds = int(expires_in) if isinstance(expires_in, int | float | str) else 3600
        self._access_token = access_token
        self._access_token_expires_at = datetime.now(UTC) + timedelta(seconds=max(ttl_seconds - 60, 60))
        return access_token

    def get(self, path: str) -> dict[str, Any]:
        return self._request("GET", path)

    def post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        return self._request("POST", path, payload=payload)

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
        try:
            response = httpx.request(
                method,
                url,
                json=payload,
                headers=headers,
                timeout=self.config.ms_graph_timeout_seconds,
            )
        except httpx.TimeoutException as error:
            raise MicrosoftGraphRequestError(None, "Microsoft Graph request timed out.") from error
        except httpx.HTTPError as error:
            raise MicrosoftGraphRequestError(None, "Microsoft Graph request failed.") from error

        if response.status_code >= 400:
            raise MicrosoftGraphRequestError(
                response.status_code,
                f"Microsoft Graph request failed with status {response.status_code}.",
            )
        if response.status_code == 204 or not response.content:
            return {}
        data = response.json()
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
