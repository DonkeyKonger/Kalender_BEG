from datetime import date
from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.api.dependencies import get_current_user
from app.api.routes import dev_test_data
from app.dev.time_gps_test_data import GeneratorSummary
from app.main import create_app
from app.models.enums import UserRole


def admin_user() -> SimpleNamespace:
    return SimpleNamespace(id=1, role=UserRole.ADMIN, is_active=True)


def office_user() -> SimpleNamespace:
    return SimpleNamespace(id=2, role=UserRole.OFFICE, is_active=True)


def test_time_gps_test_data_status_requires_admin_role():
    app = create_app()
    app.dependency_overrides[get_current_user] = office_user
    client = TestClient(app)

    response = client.get("/api/dev/time-gps-test-data/status")

    assert response.status_code == 403
    app.dependency_overrides.clear()


def test_time_gps_test_data_generate_blocked_when_disabled(monkeypatch):
    monkeypatch.setattr(dev_test_data, "is_time_gps_test_data_allowed", lambda: False)
    app = create_app()
    app.dependency_overrides[get_current_user] = admin_user
    client = TestClient(app)

    response = client.post("/api/dev/time-gps-test-data/generate", json={})

    assert response.status_code == 403
    assert response.json()["detail"] == "Testdaten-Generator ist in dieser Umgebung deaktiviert."
    app.dependency_overrides.clear()


def test_time_gps_test_data_generate_uses_existing_generator(monkeypatch):
    captured = {}

    def fake_generate(options):
        captured["options"] = options
        return GeneratorSummary(
            batch_id="timegps-test",
            start_date=options.start_date.isoformat(),
            end_date=options.end_date.isoformat(),
            random_seed=options.seed,
            people_used=4,
            sites_used=5,
            assignments_created=6,
            work_time_entries_created=7,
            gps_points_created=80,
            absences_created=1,
            scenarios={"missing_gps": 1, "plausible_normal": 1},
            expected_open_review_cases=1,
            expected_checked_cases=0,
        )

    monkeypatch.setattr(dev_test_data, "is_time_gps_test_data_allowed", lambda: True)
    monkeypatch.setattr(dev_test_data, "generate_time_gps_test_data", fake_generate)
    app = create_app()
    app.dependency_overrides[get_current_user] = admin_user
    client = TestClient(app)

    response = client.post(
        "/api/dev/time-gps-test-data/generate",
        json={
            "start_date": "2026-06-01",
            "end_date": "2026-06-07",
            "error_rate": 0.25,
            "seed": 20270601,
            "clear_previous_test_data": True,
        },
    )

    assert response.status_code == 201
    payload = response.json()
    assert payload["batch_id"] == "timegps-test"
    assert payload["gps_points_created"] == 80
    assert payload["scenarios"] == {"missing_gps": 1, "plausible_normal": 1}
    assert captured["options"].start_date == date(2026, 6, 1)
    assert captured["options"].end_date == date(2026, 6, 7)
    assert captured["options"].error_rate == 0.25
    assert captured["options"].seed == 20270601
    assert captured["options"].clear_previous_test_data is True
    app.dependency_overrides.clear()


def test_time_gps_test_data_clear_batch_uses_existing_clear(monkeypatch):
    captured = {}

    def fake_clear(*, batch_id):
        captured["batch_id"] = batch_id
        return {"gps_points": 12, "work_time_entries": 3}

    monkeypatch.setattr(dev_test_data, "is_time_gps_test_data_allowed", lambda: True)
    monkeypatch.setattr(dev_test_data, "clear_time_gps_test_data", fake_clear)
    app = create_app()
    app.dependency_overrides[get_current_user] = admin_user
    client = TestClient(app)

    response = client.delete("/api/dev/time-gps-test-data/timegps-test")

    assert response.status_code == 200
    assert response.json() == {
        "batch_id": "timegps-test",
        "all_test_data": False,
        "deleted_counts": {"gps_points": 12, "work_time_entries": 3},
    }
    assert captured["batch_id"] == "timegps-test"
    app.dependency_overrides.clear()
