from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models import Base
from app.models.enums import SiteLocationStatus, SiteStatus
from app.models.project_folder import ProjectFolder
from app.models.site import Site
from app.schemas.site import SiteCreate
from app.services.project_folder_service import ProjectFolderService
from app.services.site_service import (
    SiteService,
    apply_selected_geocode,
    clean_site_values,
    has_valid_map_location,
    site_map_item,
    site_snapshot,
)


def db_session() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    return Session(engine)


class FakeProjectStorage:
    def __init__(self, result, *, graph_enabled=True, project_folders_enabled=True):
        self.results = result if isinstance(result, list) else [result]
        self.calls = []
        self.config = SimpleNamespace(
            ms_graph_enabled=graph_enabled,
            ms_graph_create_project_folders_enabled=project_folders_enabled,
        )

    def create_project_folder_for_site(self, *, site_id, site_number, site_name):
        self.calls.append({"site_id": site_id, "site_number": site_number, "site_name": site_name})
        index = min(len(self.calls) - 1, len(self.results) - 1)
        return self.results[index]


def test_clean_site_values_trims_name_and_turns_blank_optional_text_to_none():
    values = clean_site_values(
        {
            "name": "  Neubau Halle  ",
            "location": "   ",
            "customer": "  Badener Elektro  ",
        }
    )

    assert values["name"] == "Neubau Halle"
    assert values["location"] is None
    assert values["customer"] == "Badener Elektro"


def test_clean_site_values_rejects_blank_name():
    with pytest.raises(HTTPException) as error:
        clean_site_values({"name": "  "})

    assert error.value.status_code == 400


def test_site_snapshot_uses_json_safe_status_and_dates():
    closed_at = datetime(2026, 5, 20, 10, 15, tzinfo=UTC)
    site = SimpleNamespace(
        id=1,
        site_number="B-100",
        name="Neubau Halle",
        location="Baden",
        address=None,
        postal_code="28832",
        city="Achim",
        street="Hauptstrasse",
        house_number="12",
        address_extra="Halle links",
        latitude=53.0142,
        longitude=9.0263,
        geofence_radius_m=5000,
        location_status=SiteLocationStatus.GEOCODED,
        customer="Badener Elektro",
        project_manager_person_id=3,
        status=SiteStatus.COMPLETED,
        info=None,
        color="#1d5c99",
        closed_at=closed_at,
        closed_by_user_id=4,
    )

    snapshot = site_snapshot(site)

    assert snapshot["status"] == "completed"
    assert snapshot["location_status"] == "geocoded"
    assert snapshot["geofence_radius_m"] == 5000
    assert snapshot["closed_at"] == "2026-05-20T10:15:00+00:00"


def test_has_valid_map_location_requires_coordinates_and_geocoded_status():
    site = SimpleNamespace(
        latitude=53.0142,
        longitude=9.0263,
        location_status=SiteLocationStatus.GEOCODED,
    )

    assert has_valid_map_location(site) is True

    site.location_status = SiteLocationStatus.UNCHECKED
    assert has_valid_map_location(site) is False

    site.location_status = SiteLocationStatus.GEOCODED
    site.longitude = None
    assert has_valid_map_location(site) is False


def test_site_map_item_returns_only_slim_map_fields():
    project_manager = SimpleNamespace(
        id=7,
        display_name="Christopher Erichsen",
        short_code="CE",
        email=None,
        phone=None,
    )
    site = SimpleNamespace(
        id=12,
        site_number="8014",
        name="FTZ Verden",
        city="Verden",
        location="Verden",
        postal_code="27283",
        street="Hauptstrasse",
        house_number="5",
        project_manager=project_manager,
        status=SiteStatus.ACTIVE,
        color="#1d5c99",
        latitude=52.9234,
        longitude=9.2345,
        geofence_radius_m=5000,
        location_status=SiteLocationStatus.GEOCODED,
    )

    item = site_map_item(site)

    assert item.id == 12
    assert item.number == "8014"
    assert item.city == "Verden"
    assert item.project_manager is not None
    assert item.project_manager.short_code == "CE"
    assert item.latitude == 52.9234
    assert item.geofence_radius_m == 5000


def test_apply_selected_geocode_keeps_coordinates_only_for_geocoded_selection():
    values = {
        "postal_code": "21079",
        "latitude": 53.456,
        "longitude": 9.987,
        "location_status": SiteLocationStatus.GEOCODED,
    }

    assert apply_selected_geocode(values) is True
    assert values["latitude"] == 53.456
    assert values["location_status"] == SiteLocationStatus.GEOCODED


def test_apply_selected_geocode_strips_manual_technical_location_fields():
    values = {
        "postal_code": "21079",
        "latitude": 53.456,
        "longitude": 9.987,
        "location_status": SiteLocationStatus.UNCHECKED,
    }

    assert apply_selected_geocode(values) is False
    assert "latitude" not in values
    assert "longitude" not in values
    assert values["location_status"] == SiteLocationStatus.UNCHECKED


def test_apply_selected_geocode_leaves_unrelated_updates_alone():
    values = {"customer": "Badener Elektro"}

    assert apply_selected_geocode(values) is False
    assert values == {"customer": "Badener Elektro"}


def test_site_dependency_check_keeps_empty_site_deletable():
    service = SiteService.__new__(SiteService)
    service._has_row = lambda *args: False
    site = SimpleNamespace(
        id=1,
        location=None,
        address=None,
        postal_code=None,
        city=None,
        street=None,
        house_number=None,
        address_extra=None,
        latitude=None,
        longitude=None,
    )

    assert service._site_has_dependencies(site) is False


def test_site_dependency_check_keeps_site_with_location_archivable():
    service = SiteService.__new__(SiteService)
    service._has_row = lambda *args: False
    site = SimpleNamespace(
        id=1,
        location="Hamburg",
        address=None,
        postal_code=None,
        city=None,
        street=None,
        house_number=None,
        address_extra=None,
        latitude=None,
        longitude=None,
    )

    assert service._site_has_dependencies(site) is True


def test_create_site_stores_created_project_folder_metadata():
    db = db_session()
    storage = FakeProjectStorage(
        {
            "status": "created",
            "folder_id": "folder-1",
            "folder_name": "8007_Testbaustelle",
            "web_url": "https://example.invalid/folder-1",
            "drive_id": "drive-1",
            "subfolders": [
                {
                    "sort_order": 1,
                    "name": "01_Angebote",
                    "id": "subfolder-1",
                    "web_url": "https://example.invalid/folder-1/01_Angebote",
                },
            ],
        }
    )

    site = SiteService(db, project_storage=storage).create_site(
        SiteCreate(name="Testbaustelle", site_number="8007"),
        user_id=1,
    )

    assert site.id is not None
    assert storage.calls == [
        {"site_id": site.id, "site_number": "8007", "site_name": "Testbaustelle"}
    ]
    assert site.project_folder_status == "created"
    assert site.project_folder_id == "folder-1"
    assert site.project_folder_name == "8007_Testbaustelle"
    assert site.project_folder_web_url == "https://example.invalid/folder-1"
    stored_folders = db.scalars(select(ProjectFolder).where(ProjectFolder.site_id == site.id)).all()
    assert len(stored_folders) == 15
    angebote = next(folder for folder in stored_folders if folder.sort_order == 1)
    assert angebote.external_provider == "sharepoint"
    assert angebote.external_drive_id == "drive-1"
    assert angebote.external_item_id == "subfolder-1"
    assert angebote.external_web_url == "https://example.invalid/folder-1/01_Angebote"


def test_create_site_keeps_site_when_project_folder_creation_fails():
    db = db_session()
    storage = FakeProjectStorage(
        {
            "status": "error",
            "folder_name": "8007_Testbaustelle",
            "error": "Microsoft Graph folder creation failed with status 403.",
        }
    )

    site = SiteService(db, project_storage=storage).create_site(
        SiteCreate(name="Testbaustelle", site_number="8007"),
        user_id=1,
    )

    assert site.id is not None
    assert site.project_folder_status == "error"
    assert site.project_folder_name == "8007_Testbaustelle"
    assert site.project_folder_error == "Microsoft Graph folder creation failed with status 403."
    assert db.get(type(site), site.id) is not None


def add_site(
    db: Session,
    *,
    name: str,
    status: SiteStatus = SiteStatus.ACTIVE,
    site_number: str | None = None,
    project_folder_id: str | None = None,
    project_folder_web_url: str | None = None,
) -> Site:
    site = Site(
        name=name,
        site_number=site_number,
        status=status,
        location_status=SiteLocationStatus.UNCHECKED,
        project_folder_id=project_folder_id,
        project_folder_web_url=project_folder_web_url,
    )
    db.add(site)
    db.flush()
    ProjectFolderService(db).create_default_project_folders_for_site(site.id)
    return site


def test_backfill_project_folders_requires_feature_flag():
    db = db_session()
    storage = FakeProjectStorage(
        {"status": "created"},
        graph_enabled=True,
        project_folders_enabled=False,
    )

    with pytest.raises(HTTPException) as error:
        SiteService(db, project_storage=storage).backfill_project_folders()

    assert error.value.status_code == 400
    assert "MS_GRAPH_CREATE_PROJECT_FOLDERS_ENABLED" in error.value.detail


def test_backfill_project_folders_creates_missing_open_sites_only():
    db = db_session()
    missing = add_site(db, name="Offene Baustelle", site_number="8001")
    add_site(db, name="Mit Ordner", project_folder_id="existing-folder")
    add_site(db, name="Abgeschlossen", status=SiteStatus.COMPLETED)
    storage = FakeProjectStorage(
        {
            "status": "created",
            "folder_id": "folder-1",
            "folder_name": "8001_Offene_Baustelle",
            "web_url": "https://example.invalid/folder-1",
            "drive_id": "drive-1",
            "subfolders": [
                {
                    "sort_order": 1,
                    "name": "01_Angebote",
                    "id": "subfolder-1",
                    "web_url": "https://example.invalid/folder-1/01_Angebote",
                },
            ],
        }
    )

    result = SiteService(db, project_storage=storage).backfill_project_folders(limit=10)

    assert result["total_candidates"] == 1
    assert result["created_count"] == 1
    assert result["skipped_count"] == 1
    assert result["error_count"] == 0
    assert storage.calls == [
        {"site_id": missing.id, "site_number": "8001", "site_name": "Offene Baustelle"}
    ]
    db.refresh(missing)
    assert missing.project_folder_status == "created"
    assert missing.project_folder_web_url == "https://example.invalid/folder-1"
    angebote = db.scalar(
        select(ProjectFolder).where(
            ProjectFolder.site_id == missing.id, ProjectFolder.sort_order == 1
        )
    )
    assert angebote is not None
    assert angebote.external_web_url == "https://example.invalid/folder-1/01_Angebote"


def test_backfill_project_folders_respects_limit_and_continues_after_errors():
    db = db_session()
    first = add_site(db, name="Erste Baustelle", site_number="8001")
    second = add_site(db, name="Zweite Baustelle", site_number="8002")
    third = add_site(db, name="Dritte Baustelle", site_number="8003")
    storage = FakeProjectStorage(
        [
            {
                "status": "created",
                "folder_id": "folder-1",
                "folder_name": "8001_Erste_Baustelle",
                "web_url": "https://example.invalid/folder-1",
                "drive_id": "drive-1",
                "subfolders": [],
            },
            {
                "status": "error",
                "folder_name": "8002_Zweite_Baustelle",
                "error": "Microsoft Graph folder creation failed with status 403.",
            },
        ]
    )

    result = SiteService(db, project_storage=storage).backfill_project_folders(limit=2)

    assert result["total_candidates"] == 3
    assert result["created_count"] == 1
    assert result["error_count"] == 1
    assert result["skipped_count"] == 1
    assert result["skipped"][0]["site_id"] == third.id
    assert result["skipped"][0]["reason"] == "limit_reached"
    db.refresh(first)
    db.refresh(second)
    assert first.project_folder_status == "created"
    assert second.project_folder_status == "error"
    assert "super-secret" not in str(result)
