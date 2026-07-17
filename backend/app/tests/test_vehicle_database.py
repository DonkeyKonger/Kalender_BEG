from datetime import date, datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.api.dependencies import get_current_user
from app.core.database import get_db
from app.main import create_app
from app.models import Base
from app.models.enums import GpsSourceType, PersonEmploymentStatus, PersonType, UserRole
from app.models.gps_point import GpsPoint
from app.models.person import Person
from app.models.site import Site
from app.models.user import User
from app.models.vehicle import SiteVehicleAssignment, Vehicle, VehicleAsset


def principal(role: UserRole, *permissions: str):
    return SimpleNamespace(
        id=91,
        role=role,
        is_active=True,
        must_change_password=False,
        office_page_permissions=list(permissions),
    )


@pytest.fixture()
def vehicle_context():
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    db = Session(engine)
    worker = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
        person_type=PersonType.INTERNAL,
        is_active=True,
        employment_status=PersonEmploymentStatus.ACTIVE.value,
    )
    inactive_worker = Person(
        first_name="Ina",
        last_name="Inaktiv",
        display_name="Ina Inaktiv",
        short_code="II",
        person_type=PersonType.INTERNAL,
        is_active=False,
        employment_status=PersonEmploymentStatus.DEPARTED.value,
    )
    office_person = Person(
        first_name="Olivia",
        last_name="Office",
        display_name="Olivia Office",
        short_code="OO",
        person_type=PersonType.INTERNAL,
        is_active=True,
        employment_status=PersonEmploymentStatus.ACTIVE.value,
    )
    office_user = User(
        username="olivia.office",
        display_name="Olivia Office",
        password_hash="x",
        role=UserRole.OFFICE,
        is_active=True,
        person=office_person,
    )
    asset = VehicleAsset(
        source="ctrack",
        external_id="ctrack-17",
        label="C-Track Transporter 17",
        vehicle_registration="OHZ-CT 17",
        is_active=True,
    )
    second_asset = VehicleAsset(
        source="ctrack",
        external_id="ctrack-18",
        label="C-Track Transporter 18",
        vehicle_registration="OHZ-CT 18",
        is_active=True,
    )
    db.add_all([worker, inactive_worker, office_user, asset, second_asset])
    db.commit()

    current = {"user": principal(UserRole.ADMIN)}
    app = create_app()
    app.dependency_overrides[get_current_user] = lambda: current["user"]
    app.dependency_overrides[get_db] = lambda: db
    client = TestClient(app)
    yield db, client, current, worker, inactive_worker, asset, second_asset
    app.dependency_overrides.clear()
    db.close()


def test_vehicle_crud_normalizes_plate_and_uses_stable_foreign_keys(vehicle_context):
    db, client, _, worker, _, asset, _ = vehicle_context

    created = client.post(
        "/api/admin/vehicles",
        json={
            "license_plate": "  ohz-be   247 ",
            "manufacturer": " Volkswagen ",
            "assigned_person_id": worker.id,
            "ctrack_vehicle_asset_id": asset.id,
        },
    )

    assert created.status_code == 201
    payload = created.json()
    assert payload["license_plate"] == "OHZ-BE 247"
    assert payload["manufacturer"] == "Volkswagen"
    assert payload["assigned_person"]["id"] == worker.id
    assert payload["ctrack_vehicle"]["id"] == asset.id

    updated = client.patch(
        f"/api/admin/vehicles/{payload['id']}",
        json={
            "license_plate": "ohz-be 248",
            "manufacturer": "Mercedes-Benz",
            "assigned_person_id": None,
            "ctrack_vehicle_asset_id": None,
        },
    )
    assert updated.status_code == 200
    assert updated.json()["license_plate"] == "OHZ-BE 248"
    assert updated.json()["assigned_person"] is None
    assert updated.json()["ctrack_vehicle"] is None

    deleted = client.delete(f"/api/admin/vehicles/{payload['id']}")
    assert deleted.status_code == 204
    assert db.get(VehicleAsset, asset.id) is not None
    assert db.get(Vehicle, payload["id"]) is None


def test_vehicle_delete_cleans_internal_links_without_touching_person_or_ctrack(vehicle_context):
    db, client, _, worker, _, asset, _ = vehicle_context
    site = Site(site_number="8001", name="Baustelle mit Fahrzeug")
    vehicle = Vehicle(
        license_plate="H-BP 3090",
        name="Volkswagen",
        manufacturer="Volkswagen",
        assigned_person_id=worker.id,
        ctrack_vehicle_asset_id=asset.id,
        is_active=True,
    )
    db.add_all([site, vehicle])
    db.flush()
    assignment = SiteVehicleAssignment(
        site_id=site.id,
        vehicle_id=vehicle.id,
        start_date=date(2026, 7, 17),
        end_date=date(2026, 7, 17),
    )
    gps_point = GpsPoint(
        source_type=GpsSourceType.VEHICLE,
        source_id="gps-h-bp-3090",
        vehicle_id=vehicle.id,
        latitude=53.0142,
        longitude=9.0263,
        timestamp=datetime(2026, 7, 17, 8, 0, tzinfo=timezone.utc),
    )
    db.add_all([assignment, gps_point])
    db.commit()
    vehicle_id = vehicle.id
    worker_id = worker.id
    asset_id = asset.id
    assignment_id = assignment.id
    gps_point_id = gps_point.id

    response = client.delete(f"/api/admin/vehicles/{vehicle_id}")

    assert response.status_code == 204
    db.expire_all()
    assert db.get(Vehicle, vehicle_id) is None
    assert db.get(Person, worker_id) is not None
    assert db.get(VehicleAsset, asset_id) is not None
    assert db.get(SiteVehicleAssignment, assignment_id) is None
    assert db.get(GpsPoint, gps_point_id).vehicle_id is None


def test_vehicle_delete_unknown_id_returns_404(vehicle_context):
    _db, client, *_ = vehicle_context

    response = client.delete("/api/admin/vehicles/999999")

    assert response.status_code == 404
    assert response.json()["detail"] == "Fahrzeug nicht gefunden."


def test_vehicle_uniqueness_is_case_insensitive_and_ctrack_link_is_exclusive(vehicle_context):
    _, client, _, _, _, asset, _ = vehicle_context
    first = client.post(
        "/api/admin/vehicles",
        json={
            "license_plate": "OHZ-BE 1",
            "manufacturer": "Ford",
            "ctrack_vehicle_asset_id": asset.id,
        },
    )
    assert first.status_code == 201

    duplicate_plate = client.post(
        "/api/admin/vehicles",
        json={"license_plate": "ohz-be 1", "manufacturer": "Volkswagen"},
    )
    duplicate_ctrack = client.post(
        "/api/admin/vehicles",
        json={
            "license_plate": "OHZ-BE 2",
            "manufacturer": "Volkswagen",
            "ctrack_vehicle_asset_id": asset.id,
        },
    )
    assert duplicate_plate.status_code == 409
    assert duplicate_plate.json()["detail"] == "Dieses Kennzeichen ist bereits vorhanden."
    assert duplicate_ctrack.status_code == 409
    assert duplicate_ctrack.json()["detail"] == "Dieses C-Track-Fahrzeug ist bereits verknüpft."


def test_vehicle_options_only_include_active_internal_workers_and_mark_used_ctrack(vehicle_context):
    _, client, _, worker, inactive_worker, asset, second_asset = vehicle_context
    created = client.post(
        "/api/admin/vehicles",
        json={
            "license_plate": "OHZ-BE 10",
            "manufacturer": "Ford",
            "ctrack_vehicle_asset_id": asset.id,
        },
    ).json()

    response = client.get("/api/admin/vehicles/options")

    assert response.status_code == 200
    payload = response.json()
    assert [employee["id"] for employee in payload["employees"]] == [worker.id]
    assert inactive_worker.id not in {employee["id"] for employee in payload["employees"]}
    linked = {item["id"]: item["linked_vehicle_id"] for item in payload["ctrack_vehicles"]}
    assert linked[asset.id] == created["id"]
    assert linked[second_asset.id] is None


def test_vehicle_search_and_header_sort_cover_all_displayed_fields(vehicle_context):
    _, client, _, worker, _, asset, second_asset = vehicle_context
    for plate, manufacturer, employee_id, asset_id in (
        ("OHZ-Z 2", "Volkswagen", worker.id, asset.id),
        ("OHZ-A 1", "Mercedes-Benz", None, second_asset.id),
    ):
        assert (
            client.post(
                "/api/admin/vehicles",
                json={
                    "license_plate": plate,
                    "manufacturer": manufacturer,
                    "assigned_person_id": employee_id,
                    "ctrack_vehicle_asset_id": asset_id,
                },
            ).status_code
            == 201
        )

    assert [
        item["license_plate"]
        for item in client.get("/api/admin/vehicles?sort_by=manufacturer&sort_direction=asc").json()
    ] == ["OHZ-A 1", "OHZ-Z 2"]
    assert [
        item["license_plate"]
        for item in client.get("/api/admin/vehicles?search=Max%20Monteur").json()
    ] == ["OHZ-Z 2"]
    assert [
        item["license_plate"]
        for item in client.get("/api/admin/vehicles?search=Transporter%2018").json()
    ] == ["OHZ-A 1"]


def test_vehicle_api_rejects_inactive_worker(vehicle_context):
    _, client, _, _, inactive_worker, _, _ = vehicle_context
    response = client.post(
        "/api/admin/vehicles",
        json={
            "license_plate": "OHZ-IN 1",
            "manufacturer": "Ford",
            "assigned_person_id": inactive_worker.id,
        },
    )
    assert response.status_code == 400
    assert response.json()["detail"] == "Der Monteur ist nicht aktiv oder nicht zuordenbar."


def test_vehicle_api_rejects_active_office_person_as_monteur(vehicle_context):
    db, client, _, _, _, _, _ = vehicle_context
    office_person = db.scalar(select(Person).where(Person.short_code == "OO"))
    assert office_person is not None
    response = client.post(
        "/api/admin/vehicles",
        json={
            "license_plate": "OHZ-OF 2",
            "manufacturer": "Ford",
            "assigned_person_id": office_person.id,
        },
    )
    assert response.status_code == 400
    assert response.json()["detail"] == "Der Monteur ist nicht aktiv oder nicht zuordenbar."


@pytest.mark.parametrize(
    "current_user",
    [
        principal(UserRole.OFFICE),
        principal(UserRole.PROJECT_MANAGER, "miscellaneous"),
        principal(UserRole.MONTEUR, "miscellaneous"),
    ],
)
def test_vehicle_database_requires_miscellaneous_access(vehicle_context, current_user):
    _, client, current, _, _, _, _ = vehicle_context
    current["user"] = current_user
    for method, path, payload in (
        ("get", "/api/admin/vehicles", None),
        ("get", "/api/admin/vehicles/options", None),
        ("post", "/api/admin/vehicles", {"license_plate": "X", "manufacturer": "Ford"}),
        ("patch", "/api/admin/vehicles/1", {"manufacturer": "Ford"}),
        ("delete", "/api/admin/vehicles/1", None),
    ):
        response = client.request(method, path, json=payload)
        assert response.status_code == 403


def test_opted_in_office_can_manage_vehicle_database(vehicle_context):
    _, client, current, _, _, _, _ = vehicle_context
    current["user"] = principal(UserRole.OFFICE, "miscellaneous")

    created = client.post(
        "/api/admin/vehicles",
        json={"license_plate": "OHZ-OF 1", "manufacturer": "Ford"},
    )
    assert created.status_code == 201
    assert (
        client.patch(
            f"/api/admin/vehicles/{created.json()['id']}",
            json={"manufacturer": "Volkswagen"},
        ).status_code
        == 200
    )
    assert client.delete(f"/api/admin/vehicles/{created.json()['id']}").status_code == 204
