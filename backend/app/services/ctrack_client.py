from __future__ import annotations

from typing import Any
from urllib.parse import quote

import httpx

from app.core.config import settings


class CtrackConfigError(Exception):
    def __init__(self, missing_config: list[str]) -> None:
        self.missing_config = missing_config
        super().__init__("Missing Ctrack configuration.")


class CtrackRequestError(Exception):
    def __init__(self, status_code: int | None, message: str) -> None:
        self.status_code = status_code
        super().__init__(message)


class CtrackClient:
    def __init__(self, config=settings) -> None:
        self.config = config
        self._token: str | None = None

    def login(self) -> str:
        self._ensure_config()
        if self._token:
            return self._token

        data = self._get_json(
            "/Membership/Login",
            params={
                "Username": self.config.ctrack_username,
                "Password": self.config.ctrack_password,
            },
        )
        self._token = _extract_login_token(data)
        return self._token

    def get_vehicles(self) -> Any:
        token = self.login()
        return self._get_json(f"/Vehicles/{quote(token, safe='')}/GetVehicles")

    def get_latest_positions(self) -> Any:
        token = self.login()
        return self._get_json(
            f"/Vehicles/{quote(token, safe='')}/GetLastVehiclePositionsforAuthenticatedUser"
        )

    def _get_json(self, path: str, params: dict[str, str | None] | None = None) -> Any:
        self._ensure_config()
        url = f"{self.config.ctrack_base_url.rstrip('/')}/{path.lstrip('/')}"
        try:
            response = httpx.get(url, params=params, timeout=15.0)
        except httpx.TimeoutException as error:
            raise CtrackRequestError(None, "Ctrack request timed out.") from error
        except httpx.HTTPError as error:
            raise CtrackRequestError(None, "Ctrack request failed.") from error

        data = _safe_json(response)
        if response.status_code >= 400:
            raise CtrackRequestError(
                response.status_code,
                f"Ctrack request failed with status {response.status_code}.",
            )
        return data

    def _ensure_config(self) -> None:
        missing = []
        if not self.config.ctrack_base_url:
            missing.append("CTRACK_BASE_URL")
        if not self.config.ctrack_username:
            missing.append("CTRACK_USERNAME")
        if not self.config.ctrack_password:
            missing.append("CTRACK_PASSWORD")
        if missing:
            raise CtrackConfigError(missing)


def _safe_json(response: httpx.Response) -> Any:
    try:
        return response.json()
    except ValueError:
        text = response.text.strip()
        if text:
            return text
        return None


def _extract_login_token(data: Any) -> str:
    if isinstance(data, str):
        token = data.strip().strip('"')
        if token:
            return token

    if isinstance(data, dict):
        for key in (
            "Token",
            "token",
            "LoginToken",
            "loginToken",
            "SessionToken",
            "sessionToken",
            "Result",
            "result",
            "Value",
            "value",
        ):
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        if len(data) == 1:
            value = next(iter(data.values()))
            if isinstance(value, str) and value.strip():
                return value.strip()

    raise CtrackRequestError(None, "Ctrack login token missing in response.")
