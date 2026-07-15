from datetime import date

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.api.dependencies import get_current_app_user
from app.core.database import get_db
from app.main import create_app
from app.models import Base
from app.models.absence import Absence
from app.models.enums import (
    AbsenceStatus,
    AbsenceType,
    ToolMaterialCategory,
    ToolMaterialStatus,
    UserRole,
)
from app.models.person import Person
from app.models.person_vacation_carryover import PersonVacationCarryover
from app.models.tool_material_item import ToolMaterialItem
from app.models.user import User
from app.models.vehicle import VehicleAsset
from app.services.mobile_personal_file_service import MobilePersonalFileService


def personal_file_context() -> tuple[Session, User, Person, Person]:
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
        annual_vacation_days=30,
    )
    other = Person(
        first_name="Erika",
        last_name="Extern",
        display_name="Erika Extern",
        short_code="EE",
    )
    user = User(
        username="max.monteur",
        display_name="Max Monteur",
        password_hash="x",
        role=UserRole.MONTEUR,
        is_active=True,
        person=worker,
    )
    db.add_all([worker, other, user])
    db.flush()
    db.add(
        PersonVacationCarryover(
            person_id=worker.id,
            year=2026,
            carryover_days=2,
        )
    )
    db.add_all(
        [
            Absence(
                person_id=worker.id,
                absence_type=AbsenceType.VACATION,
                start_date=date(2026, 7, 10),
                end_date=date(2026, 7, 13),
                status=AbsenceStatus.ACTIVE,
            ),
            Absence(
                person_id=worker.id,
                absence_type=AbsenceType.SICK,
                start_date=date(2026, 1, 3),
                end_date=date(2026, 1, 6),
                status=AbsenceStatus.ACTIVE,
            ),
            Absence(
                person_id=other.id,
                absence_type=AbsenceType.SICK,
                start_date=date(2026, 1, 1),
                end_date=date(2026, 1, 31),
                status=AbsenceStatus.ACTIVE,
            ),
        ]
    )
    db.add_all(
        [
            VehicleAsset(
                source="ctrack",
                external_id="own-vehicle",
                assigned_person_id=worker.id,
                label="VW Transporter",
                vehicle_registration="OHZ-BE 247",
                fleet_number="17",
                is_active=True,
            ),
            VehicleAsset(
                source="ctrack",
                external_id="other-vehicle",
                assigned_person_id=other.id,
                label="Fremdes Fahrzeug",
                is_active=True,
            ),
        ]
    )
    db.add_all(
        [
            ToolMaterialItem(
                beg_number="BEG-10",
                manufacturer="Bosch",
                designation="Bohrhammer",
                category=ToolMaterialCategory.DRILLING_SCREWING,
                employee_id=worker.id,
                item_date=date(2026, 7, 10),
                status=ToolMaterialStatus.ISSUED,
                serial_number="SECRET-1",
                supplier="Nicht mobil",
            ),
            ToolMaterialItem(
                beg_number="BEG-2",
                designation="Winkelschleifer",
                category=ToolMaterialCategory.GRINDING_CUTTING,
                employee_id=worker.id,
                item_date=date(2026, 7, 10),
                status=ToolMaterialStatus.ISSUED,
            ),
            ToolMaterialItem(
                beg_number="BEG-1",
                designation="Sauger",
                category=ToolMaterialCategory.VACUUMING,
                employee_id=worker.id,
                item_date=date(2026, 7, 12),
                status=ToolMaterialStatus.ISSUED,
            ),
            ToolMaterialItem(
                beg_number="BEG-OHNE-DATUM",
                designation="Handwerkzeug",
                category=ToolMaterialCategory.HAND_TOOLS,
                employee_id=worker.id,
                item_date=None,
                status=ToolMaterialStatus.ISSUED,
            ),
            ToolMaterialItem(
                beg_number="LAGER",
                designation="Lagergerät",
                category=ToolMaterialCategory.OTHER,
                status=ToolMaterialStatus.WAREHOUSE,
            ),
            ToolMaterialItem(
                beg_number="AUSGEBUCHT",
                designation="Ausgebucht",
                category=ToolMaterialCategory.OTHER,
                status=ToolMaterialStatus.WRITTEN_OFF,
            ),
            ToolMaterialItem(
                beg_number="FREMD",
                designation="Fremdes Werkzeug",
                category=ToolMaterialCategory.OTHER,
                employee_id=other.id,
                status=ToolMaterialStatus.ISSUED,
            ),
        ]
    )
    db.commit()
    db.refresh(user)
    db.refresh(worker)
    db.refresh(other)
    return db, user, worker, other


def test_personal_file_uses_current_person_and_central_weekday_calculation():
    db, user, _worker, _other = personal_file_context()

    summary = MobilePersonalFileService(db).get_summary(
        current_user=user,
        today=date(2026, 7, 15),
    )

    assert summary.current_year == 2026
    assert summary.total_vacation_days == 32
    assert summary.remaining_vacation_days == 30
    assert summary.sick_days == 2
    assert summary.vehicle is not None
    assert summary.vehicle.name == "VW Transporter"
    assert summary.vehicle.vehicle_registration == "OHZ-BE 247"
    assert summary.tool_count == 4
    assert [item.beg_number for item in summary.tool_preview] == ["BEG-1", "BEG-2", "BEG-10"]
    db.close()


def test_personal_file_tool_list_is_reduced_sorted_and_excludes_other_statuses():
    db, user, _worker, _other = personal_file_context()

    tools = MobilePersonalFileService(db).list_tools(current_user=user)

    assert [item.beg_number for item in tools] == [
        "BEG-1",
        "BEG-2",
        "BEG-10",
        "BEG-OHNE-DATUM",
    ]
    assert {item.category for item in tools} == {
        ToolMaterialCategory.DRILLING_SCREWING,
        ToolMaterialCategory.GRINDING_CUTTING,
        ToolMaterialCategory.VACUUMING,
        ToolMaterialCategory.HAND_TOOLS,
    }
    db.close()


def test_personal_file_vehicle_empty_state_does_not_fall_back_to_foreign_vehicle():
    db, user, worker, _other = personal_file_context()
    own_vehicle = db.scalar(
        select(VehicleAsset).where(VehicleAsset.assigned_person_id == worker.id)
    )
    assert own_vehicle is not None
    db.delete(own_vehicle)
    db.commit()

    summary = MobilePersonalFileService(db).get_summary(
        current_user=user,
        today=date(2026, 7, 15),
    )

    assert summary.vehicle is None
    db.close()


def test_personal_file_api_ignores_manipulated_person_id_and_exposes_no_admin_fields():
    db, user, _worker, other = personal_file_context()
    app = create_app()
    app.dependency_overrides[get_current_app_user] = lambda: user
    app.dependency_overrides[get_db] = lambda: db
    client = TestClient(app)

    summary_response = client.get(f"/api/me/personal-file?person_id={other.id}")
    tools_response = client.get(f"/api/me/personal-file/tools?person_id={other.id}")

    assert summary_response.status_code == 200
    assert summary_response.json()["vehicle"]["name"] == "VW Transporter"
    assert summary_response.json()["tool_count"] == 4
    assert tools_response.status_code == 200
    assert {item["beg_number"] for item in tools_response.json()} == {
        "BEG-1",
        "BEG-2",
        "BEG-10",
        "BEG-OHNE-DATUM",
    }
    assert set(tools_response.json()[0]) == {
        "category",
        "beg_number",
        "manufacturer",
        "designation",
        "item_date",
    }
    assert "serial_number" not in tools_response.json()[0]
    assert "supplier" not in tools_response.json()[0]
    assert "employee_id" not in tools_response.json()[0]
    app.dependency_overrides.clear()
    db.close()


def test_personal_file_reflects_assignment_changes_on_next_request():
    db, user, worker, other = personal_file_context()
    service = MobilePersonalFileService(db)
    item = next(
        item
        for item in db.query(ToolMaterialItem).all()
        if item.beg_number == "BEG-1"
    )
    assert service.get_summary(current_user=user, today=date(2026, 7, 15)).tool_count == 4

    item.employee_id = other.id
    db.commit()

    assert service.get_summary(current_user=user, today=date(2026, 7, 15)).tool_count == 3
    assert item.employee_id != worker.id
    db.close()


def test_personal_file_handles_missing_person_and_rejects_other_roles():
    db, user, _worker, _other = personal_file_context()
    user.person_id = None
    with pytest.raises(HTTPException) as missing_error:
        MobilePersonalFileService(db).get_summary(current_user=user, today=date(2026, 7, 15))
    assert missing_error.value.status_code == 400

    user.role = UserRole.PROJECT_MANAGER
    with pytest.raises(HTTPException) as role_error:
        MobilePersonalFileService(db).get_summary(current_user=user, today=date(2026, 7, 15))
    assert role_error.value.status_code == 403
    db.close()
