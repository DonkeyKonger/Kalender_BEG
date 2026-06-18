from __future__ import annotations

import json
import logging
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx
import jwt
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.core.config import settings
from app.models.assignment import Assignment
from app.models.enums import UserRole
from app.models.push_notification import PendingPlanPushNotification, UserPushDevice
from app.models.site import Site
from app.models.site_measurement_item import SiteMeasurementBatch
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
        was_new_device = device is None
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
        logger.info(
            "Push token registered: user_id=%s push_device_id=%s platform=%s is_active=%s token_suffix=%s last_seen_at=%s was_new=%s.",
            user.id,
            device.id,
            device.platform,
            device.is_active,
            _token_suffix(device.token),
            device.last_seen_at.isoformat() if device.last_seen_at else None,
            was_new_device,
        )
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
            body = self._build_plan_change_body(
                user_id=pending.user_id,
                change_count=pending.change_count,
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
            logger.info(
                "Measurement reviewed push skipped: no target user (site_id=%s batch_id=%s).",
                site_id,
                batch_id,
            )
            return
        logger.info(
            "Measurement reviewed push requested: user_id=%s site_id=%s batch_id=%s.",
            user_id,
            site_id,
            batch_id,
        )
        self.send_to_user(
            user_id=user_id,
            title="Aufmaß geprüft",
            body=self._build_measurement_reviewed_body(site_id=site_id, batch_id=batch_id),
            data={
                "type": "measurement_reviewed",
                "site_id": str(site_id),
                "batch_id": str(batch_id),
                "measurement_id": str(batch_id),
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
        notification_type = (data or {}).get("type")
        devices = list(
            self.db.scalars(
                select(UserPushDevice).where(
                    UserPushDevice.user_id == user_id,
                    UserPushDevice.is_active.is_(True),
                )
            )
        )
        logger.info(
            "Push active token count: user_id=%s count=%s type=%s.",
            user_id,
            len(devices),
            notification_type,
        )
        if not devices:
            logger.info("Push skipped: no active device tokens for user_id=%s type=%s.", user_id, notification_type)
            return

        for device in devices:
            result = _send_fcm_message(
                token=device.token,
                title=title,
                body=body,
                data=data or {},
            )
            logger.info(
                "Push delivery result: user_id=%s device_id=%s platform=%s result=%s type=%s.",
                user_id,
                device.id,
                device.platform,
                result,
                notification_type,
            )
            if result == "invalid_token":
                device.is_active = False
        self.db.commit()

    def _build_plan_change_body(self, *, user_id: int, change_count: int) -> str:
        user = self.db.get(User, user_id)
        if user is not None and user.person_id is not None:
            tomorrow = date.today() + timedelta(days=1)
            overmorrow = tomorrow + timedelta(days=1)
            lines = []
            for label, target_date in (("Morgen", tomorrow), ("Übermorgen", overmorrow)):
                site_names = self._assignment_site_names(
                    person_id=user.person_id,
                    target_date=target_date,
                )
                if site_names:
                    lines.append(f"{label}: {', '.join(site_names)}")
            if lines:
                return "Deine nächsten Einsätze:\n" + "\n".join(lines)

        if change_count > 1:
            return (
                f"Deine Einsatzplanung wurde {change_count}x aktualisiert. "
                "Bitte prüfe deine nächsten Einsätze."
            )
        return "Deine Einsatzplanung wurde aktualisiert. Bitte prüfe deine nächsten Einsätze."

    def _assignment_site_names(self, *, person_id: int, target_date: date) -> list[str]:
        assignments = list(
            self.db.scalars(
                select(Assignment)
                .options(selectinload(Assignment.site))
                .where(
                    Assignment.person_id == person_id,
                    Assignment.start_date <= target_date,
                    Assignment.end_date >= target_date,
                )
                .order_by(Assignment.start_date, Assignment.end_date, Assignment.id)
            )
        )
        site_names: list[str] = []
        for assignment in assignments:
            site_name = _clean_text(assignment.site.name if assignment.site else None)
            if site_name and site_name not in site_names:
                site_names.append(site_name)
        return site_names

    def _build_measurement_reviewed_body(self, *, site_id: int, batch_id: int) -> str:
        batch = self.db.scalar(
            select(SiteMeasurementBatch)
            .options(selectinload(SiteMeasurementBatch.site).selectinload(Site.project_manager))
            .where(
                SiteMeasurementBatch.id == batch_id,
                SiteMeasurementBatch.site_id == site_id,
            )
        )
        measurement_label = _measurement_label(batch)
        project_manager_name = _clean_text(
            batch.site.project_manager.display_name
            if batch is not None and batch.site and batch.site.project_manager
            else None
        )
        reviewer = project_manager_name or "dem Projektleiter"
        return f"Dein {measurement_label} wurde von {reviewer} geprüft"


def _send_fcm_message(
    *,
    token: str,
    title: str,
    body: str,
    data: dict[str, str],
) -> str:
    notification_type = data.get("type")
    token_suffix = _token_suffix(token)
    if not settings.fcm_enabled:
        logger.info(
            "FCM send skipped: result=disabled type=%s token_suffix=%s fcm_enabled=false.",
            notification_type,
            token_suffix,
        )
        return "disabled"

    service_account = _load_fcm_service_account()
    if not service_account:
        logger.warning(
            "FCM send skipped: result=missing_config type=%s token_suffix=%s has_project_id=%s has_json=%s has_file=%s.",
            notification_type,
            token_suffix,
            bool(settings.fcm_project_id),
            bool(settings.fcm_service_account_json),
            bool(settings.fcm_service_account_file),
        )
        return "missing_config"

    project_id = settings.fcm_project_id or service_account.get("project_id")
    if not project_id:
        logger.warning(
            "FCM send skipped: result=missing_config type=%s token_suffix=%s reason=no_project_id.",
            notification_type,
            token_suffix,
        )
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
        logger.exception(
            "FCM send failed unexpectedly: type=%s token_suffix=%s.",
            notification_type,
            token_suffix,
        )
        return "error"

    if response.status_code < 400:
        logger.info(
            "FCM send success: type=%s token_suffix=%s project_id=%s.",
            notification_type,
            token_suffix,
            project_id,
        )
        return "sent"

    response_text = response.text
    if response.status_code in {400, 404} and (
        "UNREGISTERED" in response_text or "INVALID_ARGUMENT" in response_text
    ):
        logger.info(
            "FCM token is invalid and will be deactivated: type=%s token_suffix=%s status=%s.",
            notification_type,
            token_suffix,
            response.status_code,
        )
        return "invalid_token"

    logger.warning(
        "FCM send failed: type=%s token_suffix=%s status=%s body=%s",
        notification_type,
        token_suffix,
        response.status_code,
        response_text,
    )
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


def _measurement_label(batch: SiteMeasurementBatch | None) -> str:
    if batch is None:
        return "Aufmaß"
    if batch.number is not None:
        return f"Aufmaß {batch.number}"
    title = _clean_text(batch.title)
    return title or "Aufmaß"


def _clean_text(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = " ".join(value.split())
    return cleaned or None


def _token_suffix(token: str | None) -> str:
    if not token:
        return "-"
    return token[-8:]
