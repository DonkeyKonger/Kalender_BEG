from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
import jwt
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.enums import UserRole
from app.models.push_notification import PendingPlanPushNotification, UserPushDevice
from app.models.user import User
from app.schemas.push import PushDeviceRegister


logger = logging.getLogger(__name__)

FCM_TOKEN_URL = "https://oauth2.googleapis.com/token"
FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging"


class PushNotificationService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def register_device(self, *, user: User, payload: PushDeviceRegister) -> UserPushDevice:
        now = _utcnow()
        device = self.db.scalar(select(UserPushDevice).where(UserPushDevice.token == payload.token))
        if device is None:
            device = UserPushDevice(
                user_id=user.id,
                platform=payload.platform,
                token=payload.token,
                device_id=payload.device_id,
                is_active=True,
                last_seen_at=now,
            )
            self.db.add(device)
        else:
            device.user_id = user.id
            device.platform = payload.platform
            device.device_id = payload.device_id
            device.is_active = True
            device.last_seen_at = now
        self.db.commit()
        self.db.refresh(device)
        return device

    def deactivate_device(self, *, user: User, token: str) -> None:
        device = self.db.scalar(
            select(UserPushDevice).where(
                UserPushDevice.user_id == user.id,
                UserPushDevice.token == token,
            )
        )
        if device is not None:
            device.is_active = False
            self.db.commit()

    def record_plan_change_for_person(self, person_id: int) -> None:
        user = self.db.scalar(
            select(User).where(
                User.person_id == person_id,
                User.role == UserRole.MONTEUR,
                User.is_active.is_(True),
            )
        )
        if user is None:
            return

        now = _utcnow()
        pending = self.db.scalar(
            select(PendingPlanPushNotification).where(
                PendingPlanPushNotification.user_id == user.id,
                PendingPlanPushNotification.sent_at.is_(None),
            )
        )
        if pending is None:
            self.db.add(
                PendingPlanPushNotification(
                    user_id=user.id,
                    change_count=1,
                    first_changed_at=now,
                    last_changed_at=now,
                )
            )
        else:
            pending.change_count += 1
            pending.last_changed_at = now

    def send_due_plan_change_notifications(self) -> int:
        pending_notifications = list(
            self.db.scalars(
                select(PendingPlanPushNotification).where(
                    PendingPlanPushNotification.sent_at.is_(None)
                )
            )
        )
        sent_count = 0
        now = _utcnow()
        for pending in pending_notifications:
            body = "Deine Einsatzplanung wurde aktualisiert. Bitte prüfe deine nächsten Einsätze."
            if pending.change_count > 1:
                body = (
                    f"Deine Einsatzplanung wurde {pending.change_count}x aktualisiert. "
                    "Bitte prüfe deine nächsten Einsätze."
                )
            self.send_to_user(
                user_id=pending.user_id,
                title="Einsatzplanung aktualisiert",
                body=body,
                data={"type": "plan_update", "target": "assignments"},
            )
            pending.sent_at = now
            sent_count += 1
        self.db.commit()
        return sent_count

    def send_measurement_reviewed(self, *, user_id: int | None, site_id: int, batch_id: int) -> None:
        if user_id is None:
            return
        self.send_to_user(
            user_id=user_id,
            title="Aufmaß geprüft",
            body="Dein Aufmaß wurde geprüft.",
            data={
                "type": "measurement_reviewed",
                "site_id": str(site_id),
                "batch_id": str(batch_id),
            },
        )

    def send_to_user(
        self,
        *,
        user_id: int,
        title: str,
        body: str,
        data: dict[str, str] | None = None,
    ) -> None:
        devices = list(
            self.db.scalars(
                select(UserPushDevice).where(
                    UserPushDevice.user_id == user_id,
                    UserPushDevice.is_active.is_(True),
                )
            )
        )
        if not devices:
            return

        for device in devices:
            result = _send_fcm_message(
                token=device.token,
                title=title,
                body=body,
                data=data or {},
            )
            if result == "invalid_token":
                device.is_active = False
        self.db.commit()


def _send_fcm_message(
    *,
    token: str,
    title: str,
    body: str,
    data: dict[str, str],
) -> str:
    if not settings.fcm_enabled:
        logger.info("FCM send skipped because FCM_ENABLED is false.")
        return "disabled"

    service_account = _load_fcm_service_account()
    if not service_account:
        logger.warning("FCM send skipped because no service account is configured.")
        return "missing_config"

    project_id = settings.fcm_project_id or service_account.get("project_id")
    if not project_id:
        logger.warning("FCM send skipped because no project id is configured.")
        return "missing_config"

    try:
        access_token = _create_fcm_access_token(service_account)
        response = httpx.post(
            f"https://fcm.googleapis.com/v1/projects/{project_id}/messages:send",
            headers={"Authorization": f"Bearer {access_token}"},
            json={
                "message": {
                    "token": token,
                    "notification": {"title": title, "body": body},
                    "data": data,
                    "android": {"priority": "normal"},
                }
            },
            timeout=settings.fcm_request_timeout_seconds,
        )
    except Exception:
        logger.exception("FCM send failed unexpectedly.")
        return "error"

    if response.status_code < 400:
        return "sent"

    response_text = response.text
    if response.status_code in {400, 404} and (
        "UNREGISTERED" in response_text or "INVALID_ARGUMENT" in response_text
    ):
        logger.info("FCM token is invalid and will be deactivated.")
        return "invalid_token"

    logger.warning("FCM send failed: status=%s body=%s", response.status_code, response_text)
    return "error"


def _load_fcm_service_account() -> dict[str, Any] | None:
    if settings.fcm_service_account_json:
        try:
            return json.loads(settings.fcm_service_account_json)
        except json.JSONDecodeError:
            logger.exception("FCM_SERVICE_ACCOUNT_JSON is not valid JSON.")
            return None
    if settings.fcm_service_account_file:
        path = Path(settings.fcm_service_account_file)
        if not path.exists():
            logger.warning("FCM service account file does not exist: %s", path)
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            logger.exception("Could not read FCM service account file: %s", path)
            return None
    return None


def _create_fcm_access_token(service_account: dict[str, Any]) -> str:
    issued_at = int(time.time())
    assertion = jwt.encode(
        {
            "iss": service_account["client_email"],
            "scope": FCM_SCOPE,
            "aud": FCM_TOKEN_URL,
            "iat": issued_at,
            "exp": issued_at + 3600,
        },
        service_account["private_key"],
        algorithm="RS256",
    )
    response = httpx.post(
        FCM_TOKEN_URL,
        data={
            "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
            "assertion": assertion,
        },
        timeout=settings.fcm_request_timeout_seconds,
    )
    response.raise_for_status()
    payload = response.json()
    return str(payload["access_token"])


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)
