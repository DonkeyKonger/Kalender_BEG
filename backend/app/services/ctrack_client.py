from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
import re
from typing import Any
from urllib.parse import quote

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.vehicle import VehicleAsset, VehicleLatestPosition, VehiclePositionLog


SOURCE_CTRACK = "ctrack"


class CtrackConfigError(Exception):
    def __init__(self, missing_config: list[str]) -> None:
        self.missing_config = missing_config
        super().__init__("Missing Ctrack configuration.")


class CtrackRequestError(Exception):
    def __init__(self, status_code: int | None, message: str, *, url: str | None = None) -> None:
        self.status_code = status_code
        self.url = url
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
        safe_url = url
        try:
            response = httpx.get(url, params=params, timeout=15.0)
        except httpx.TimeoutException as error:
            raise CtrackRequestError(None, "Ctrack request timed out.", url=safe_url) from error
        except httpx.HTTPError as error:
            raise CtrackRequestError(None, "Ctrack request failed.", url=safe_url) from error

        data = _safe_json(response)
        if response.status_code >= 400:
            raise CtrackRequestError(
                response.status_code,
                f"Ctrack request failed with status {response.status_code}.",
                url=safe_url,
            )
        return data

    def _ensure_config(self) -> None:
        missing = []
        if not self.config.ctrack_base_url:
            missing.append("CTRACK_BASE_URL")
        elif not self.config.ctrack_base_url.startswith(("http://", "https://")):
            missing.append("CTRACK_BASE_URL")
        if not self.config.ctrack_username:
            missing.append("CTRACK_USERNAME")
        if not self.config.ctrack_password:
            missing.append("CTRACK_PASSWORD")
        if missing:
            raise CtrackConfigError(missing)


@dataclass(frozen=True)
class CtrackPositionPayload:
    external_id: str | None
    event_time_utc: datetime
    latitude: float
    longitude: float
    speed: float | None
    ignition: bool | None
    odometer: float | None
    heading_text: str | None
    driver_id: str | None
    driver_name: str | None
    location_text: str | None
    raw_payload: dict[str, Any]


class CtrackVehicleSyncService:
    def __init__(self, db: Session, client: CtrackClient | None = None) -> None:
        self.db = db
        self.client = client or CtrackClient()

    def sync_now(self) -> dict[str, int]:
        vehicles_response = self.client.get_vehicles()
        vehicle_items = _extract_item_list(
            vehicles_response,
            (
                "VehicleList",
                "Vehicles",
                "vehicles",
                "Vehicle",
                "vehicleList",
                "data",
                "Data",
            ),
        )
        assets_by_external_id: dict[str, VehicleAsset] = {}
        vehicles_received = len(vehicle_items)
        vehicles_upserted = 0
        vehicles_skipped = 0

        for item in vehicle_items:
            if not isinstance(item, dict):
                vehicles_skipped += 1
                continue
            asset = self._upsert_vehicle_asset(item)
            if asset is None:
                vehicles_skipped += 1
                continue
            assets_by_external_id[asset.external_id] = asset
            vehicles_upserted += 1

        positions_response = self.client.get_latest_positions()
        position_items = _extract_item_list(
            positions_response,
            (
                "LastVehiclePositions",
                "VehiclePositions",
                "Positions",
                "PositionList",
                "positions",
                "VehiclePosition",
                "data",
                "Data",
            ),
        )
        positions_received = len(position_items)
        positions_inserted = 0
        latest_positions_updated = 0
        positions_skipped = 0

        for item in position_items:
            if not isinstance(item, dict):
                positions_skipped += 1
                continue
            external_id = _extract_external_id(item)
            if external_id is None:
                positions_skipped += 1
                continue
            asset = assets_by_external_id.get(external_id)
            if asset is None:
                asset = self._get_or_create_asset_from_position(item, external_id)
                assets_by_external_id[external_id] = asset

            position = _parse_position_payload(item)
            if position is None:
                positions_skipped += 1
                continue
            if self._insert_position_log(asset, position):
                positions_inserted += 1
            if self._upsert_latest_position(asset, position):
                latest_positions_updated += 1

        self.db.commit()
        return {
            "vehicles_received": vehicles_received,
            "vehicles_upserted": vehicles_upserted,
            "vehicles_skipped": vehicles_skipped,
            "positions_received": positions_received,
            "positions_inserted": positions_inserted,
            "latest_positions_updated": latest_positions_updated,
            "positions_skipped": positions_skipped,
        }

    def list_vehicle_assets(self) -> list[dict[str, Any]]:
        assets = self.db.scalars(
            select(VehicleAsset).order_by(VehicleAsset.label, VehicleAsset.id)
        ).all()
        return [_serialize_vehicle_asset(asset) for asset in assets]

    def list_latest_positions(self) -> list[dict[str, Any]]:
        rows = self.db.execute(
            select(VehicleLatestPosition, VehicleAsset)
            .join(VehicleAsset, VehicleLatestPosition.vehicle_asset_id == VehicleAsset.id)
            .order_by(VehicleLatestPosition.event_time_utc.desc())
        ).all()
        return [
            {
                "vehicle": _serialize_vehicle_asset(asset),
                "position": _serialize_latest_position(position),
            }
            for position, asset in rows
        ]

    def _upsert_vehicle_asset(self, item: dict[str, Any]) -> VehicleAsset | None:
        external_id = _extract_external_id(item)
        if external_id is None:
            return None

        asset = self.db.scalar(
            select(VehicleAsset).where(
                VehicleAsset.source == SOURCE_CTRACK,
                VehicleAsset.external_id == external_id,
            )
        )
        if asset is None:
            asset = VehicleAsset(source=SOURCE_CTRACK, external_id=external_id)
            self.db.add(asset)

        asset.ctrack_node_id = _to_int(
            _first_value(item, ("NodeId", "NodeID", "nodeId", "nodeID"))
        )
        asset.label = _to_str(
            _first_value(
                item,
                (
                    "Description",
                    "description",
                    "VehicleDescription",
                    "VehicleName",
                    "Name",
                    "name",
                    "DisplayName",
                ),
            )
        )
        asset.vehicle_registration = _to_str(
            _first_value(
                item,
                (
                    "Registration",
                    "VehicleRegistration",
                    "RegistrationNumber",
                    "RegNumber",
                    "RegNo",
                    "LicensePlate",
                    "NumberPlate",
                ),
            )
        )
        asset.fleet_number = _to_str(
            _first_value(item, ("FleetNumber", "fleetNumber", "FleetNo", "FleetId"))
        )
        asset.description = _to_str(
            _first_value(item, ("LongDescription", "Notes", "notes", "Comment", "comment"))
        )
        is_active = _to_bool(
            _first_value(item, ("IsActive", "isActive", "Active", "active"))
        )
        asset.is_active = True if is_active is None else is_active
        asset.raw_payload = item
        self.db.flush()
        return asset

    def _get_or_create_asset_from_position(
        self,
        item: dict[str, Any],
        external_id: str,
    ) -> VehicleAsset:
        asset = self.db.scalar(
            select(VehicleAsset).where(
                VehicleAsset.source == SOURCE_CTRACK,
                VehicleAsset.external_id == external_id,
            )
        )
        if asset is None:
            asset = VehicleAsset(
                source=SOURCE_CTRACK,
                external_id=external_id,
                ctrack_node_id=_to_int(
                    _first_value(item, ("NodeId", "NodeID", "nodeId", "nodeID"))
                ),
                label=_to_str(
                    _first_value(
                        item,
                        (
                            "VehicleDescription",
                            "Description",
                            "VehicleName",
                            "Name",
                            "Registration",
                            "RegistrationNumber",
                        ),
                    )
                ),
                vehicle_registration=_to_str(
                    _first_value(
                        item,
                        (
                            "Registration",
                            "RegistrationNumber",
                            "RegNumber",
                            "RegNo",
                            "LicensePlate",
                        ),
                    )
                ),
                is_active=True,
                raw_payload=item,
            )
            self.db.add(asset)
            self.db.flush()
        return asset

    def _insert_position_log(
        self,
        asset: VehicleAsset,
        position: CtrackPositionPayload,
    ) -> bool:
        existing_id = self.db.scalar(
            select(VehiclePositionLog.id).where(
                VehiclePositionLog.vehicle_asset_id == asset.id,
                VehiclePositionLog.source == SOURCE_CTRACK,
                VehiclePositionLog.event_time_utc == position.event_time_utc,
            )
        )
        if existing_id is not None:
            return False

        self.db.add(
            VehiclePositionLog(
                vehicle_asset_id=asset.id,
                source=SOURCE_CTRACK,
                external_id=position.external_id,
                event_time_utc=position.event_time_utc,
                received_at=datetime.now(UTC),
                latitude=position.latitude,
                longitude=position.longitude,
                speed=position.speed,
                ignition=position.ignition,
                odometer=position.odometer,
                heading_text=position.heading_text,
                driver_id=position.driver_id,
                driver_name=position.driver_name,
                location_text=position.location_text,
                raw_payload=position.raw_payload,
            )
        )
        return True

    def _upsert_latest_position(
        self,
        asset: VehicleAsset,
        position: CtrackPositionPayload,
    ) -> bool:
        latest = self.db.scalar(
            select(VehicleLatestPosition).where(
                VehicleLatestPosition.vehicle_asset_id == asset.id,
            )
        )
        if latest is not None and _as_utc(latest.event_time_utc) >= position.event_time_utc:
            return False

        if latest is None:
            latest = VehicleLatestPosition(vehicle_asset_id=asset.id)
            self.db.add(latest)

        latest.event_time_utc = position.event_time_utc
        latest.latitude = position.latitude
        latest.longitude = position.longitude
        latest.speed = position.speed
        latest.ignition = position.ignition
        latest.odometer = position.odometer
        latest.driver_id = position.driver_id
        latest.driver_name = position.driver_name
        latest.location_text = position.location_text
        latest.source = SOURCE_CTRACK
        latest.raw_payload = position.raw_payload
        latest.updated_at = datetime.now(UTC)
        return True


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


def _extract_item_list(data: Any, preferred_keys: tuple[str, ...]) -> list[Any]:
    if isinstance(data, list):
        return data
    if not isinstance(data, dict):
        return []

    for key in preferred_keys:
        if key not in data:
            continue
        value = data[key]
        if isinstance(value, list):
            return value
        if isinstance(value, dict):
            nested = _extract_item_list(value, preferred_keys)
            if nested:
                return nested
            return [value]

    for value in data.values():
        if isinstance(value, list) and any(isinstance(item, dict) for item in value):
            return value
        if isinstance(value, dict):
            nested = _extract_item_list(value, preferred_keys)
            if nested:
                return nested
    return []


def _parse_position_payload(item: dict[str, Any]) -> CtrackPositionPayload | None:
    event_time = _parse_datetime(
        _first_value(
            item,
            (
                "EventTimeUTC",
                "eventTimeUtc",
                "EventTime",
                "eventTime",
                "TimeStampUTC",
                "TimestampUTC",
                "TimeStamp",
                "Timestamp",
                "GPSDateTime",
                "GpsDateTime",
                "GPSTime",
                "PositionDateTime",
                "UtcDateTime",
                "DateTime",
                "Date",
            ),
        )
    )
    latitude = _to_float(
        _first_value(
            item,
            ("Latitude", "latitude", "Lat", "lat", "GPSLatitude", "GpsLatitude", "Y"),
        )
    )
    longitude = _to_float(
        _first_value(
            item,
            (
                "Longitude",
                "longitude",
                "Lon",
                "lon",
                "Lng",
                "lng",
                "GPSLongitude",
                "GpsLongitude",
                "X",
            ),
        )
    )
    if event_time is None or latitude is None or longitude is None:
        return None

    return CtrackPositionPayload(
        external_id=_to_str(
            _first_value(
                item,
                ("PositionId", "positionId", "EventId", "eventId", "MessageId", "messageId"),
            )
        ),
        event_time_utc=event_time,
        latitude=latitude,
        longitude=longitude,
        speed=_to_float(_first_value(item, ("Speed", "speed", "SpeedKph", "speedKph"))),
        ignition=_to_bool(
            _first_value(item, ("Ignition", "ignition", "IgnitionOn", "ignitionOn"))
        ),
        odometer=_to_float(
            _first_value(item, ("Odometer", "odometer", "OdometerKm", "odometerKm"))
        ),
        heading_text=_to_str(
            _first_value(item, ("Heading", "heading", "Direction", "direction"))
        ),
        driver_id=_to_str(
            _first_value(item, ("DriverId", "driverId", "DriverID", "driverID"))
        ),
        driver_name=_to_str(_first_value(item, ("DriverName", "driverName", "Driver"))),
        location_text=_to_str(
            _first_value(
                item,
                ("Location", "location", "LocationText", "Address", "address", "PlaceName"),
            )
        ),
        raw_payload=item,
    )


def _extract_external_id(item: dict[str, Any]) -> str | None:
    value = _first_value(
        item,
        (
            "NodeId",
            "NodeID",
            "nodeId",
            "nodeID",
            "VehicleId",
            "VehicleID",
            "vehicleId",
            "vehicleID",
            "AssetId",
            "assetId",
        ),
    )
    return _to_str(value)


def _first_value(item: dict[str, Any], keys: tuple[str, ...]) -> Any:
    for key in keys:
        value = item.get(key)
        if value is not None and value != "":
            return value
    return None


def _to_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _to_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(float(str(value).strip()))
    except (TypeError, ValueError):
        return None


def _to_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(str(value).strip().replace(",", "."))
    except (TypeError, ValueError):
        return None


def _to_bool(value: Any) -> bool | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "y", "on", "active"}:
        return True
    if text in {"0", "false", "no", "n", "off", "inactive"}:
        return False
    return None


def _parse_datetime(value: Any) -> datetime | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return _as_utc(value)
    if isinstance(value, (int, float)):
        timestamp = float(value)
        if timestamp > 10_000_000_000:
            timestamp = timestamp / 1000
        return datetime.fromtimestamp(timestamp, tz=UTC)

    text = str(value).strip()
    microsoft_match = re.fullmatch(r"/Date\((\d+)(?:[+-]\d+)?\)/", text)
    if microsoft_match:
        timestamp = int(microsoft_match.group(1)) / 1000
        return datetime.fromtimestamp(timestamp, tz=UTC)

    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return _as_utc(parsed)


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _serialize_vehicle_asset(asset: VehicleAsset) -> dict[str, Any]:
    return {
        "id": asset.id,
        "source": asset.source,
        "external_id": asset.external_id,
        "ctrack_node_id": asset.ctrack_node_id,
        "label": asset.label,
        "vehicle_registration": asset.vehicle_registration,
        "fleet_number": asset.fleet_number,
        "description": asset.description,
        "is_active": asset.is_active,
        "created_at": _isoformat(asset.created_at),
        "updated_at": _isoformat(asset.updated_at),
    }


def _serialize_latest_position(position: VehicleLatestPosition) -> dict[str, Any]:
    return {
        "id": position.id,
        "vehicle_asset_id": position.vehicle_asset_id,
        "source": position.source,
        "event_time_utc": _isoformat(position.event_time_utc),
        "latitude": position.latitude,
        "longitude": position.longitude,
        "speed": position.speed,
        "ignition": position.ignition,
        "odometer": position.odometer,
        "driver_id": position.driver_id,
        "driver_name": position.driver_name,
        "location_text": position.location_text,
        "updated_at": _isoformat(position.updated_at),
    }


def _isoformat(value: datetime | None) -> str | None:
    if value is None:
        return None
    return _as_utc(value).isoformat()
