from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models import Base
from app.models.vehicle import VehicleLatestPosition, VehiclePositionLog
from app.services.ctrack_client import CtrackVehicleSyncService


class DemoCtrackClient:
    def get_vehicles(self):
        return {
            "ErrorCode": 0,
            "VehicleList": [
                {
                    "NodeId": 28235,
                    "Description": "Demo Vehicle",
                    "Registration": "DEMO-1",
                },
            ],
        }

    def get_latest_positions(self):
        return {
            "ErrorCode": 0,
            "LastVehiclePositions": [
                {
                    "NodeId": 28235,
                    "Ignition": False,
                    "Latitude": 53.84812927246094,
                    "Longitude": -1.6243619918823242,
                    "Location": "near 39 Holly Avenue; in Leeds; England; LS16 6PL; ",
                    "Speed": 0,
                    "HeadingText": "",
                    "DriverId": "New Driver 2",
                    "EventTimeUTC": "2026-06-08T12:05:29Z",
                },
            ],
        }


def test_ctrack_sync_persists_demo_latest_position_fields():
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)

    with Session(engine) as db:
        result = CtrackVehicleSyncService(db, DemoCtrackClient()).sync_now()

        assert result["vehicles_received"] == 1
        assert result["vehicles_upserted"] == 1
        assert result["positions_received"] == 1
        assert result["positions_inserted"] == 1
        assert result["latest_positions_updated"] == 1
        assert result["positions_skipped"] == 0

        latest = db.query(VehicleLatestPosition).one()
        assert latest.latitude == 53.84812927246094
        assert latest.longitude == -1.6243619918823242
        assert latest.location_text == "near 39 Holly Avenue; in Leeds; England; LS16 6PL;"

        payload = CtrackVehicleSyncService(db).list_latest_positions()
        assert payload[0]["vehicle"]["external_id"] == "28235"
        assert payload[0]["vehicle"]["vehicle_registration"] == "DEMO-1"
        assert payload[0]["position"]["latitude"] == 53.84812927246094
        assert payload[0]["position"]["longitude"] == -1.6243619918823242


def test_ctrack_sync_does_not_duplicate_same_vehicle_event_time():
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)

    with Session(engine) as db:
        service = CtrackVehicleSyncService(db, DemoCtrackClient())

        first = service.sync_now()
        second = service.sync_now()

        assert first["positions_inserted"] == 1
        assert first["latest_positions_updated"] == 1
        assert second["positions_inserted"] == 0
        assert second["latest_positions_updated"] == 0
        assert db.query(VehiclePositionLog).count() == 1
        assert db.query(VehicleLatestPosition).count() == 1
