from sqlalchemy import func, select
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.models import Base
from app.models.dashboard_message_dismissal import DashboardMessageDismissal
from app.models.enums import PersonType, UserRole
from app.models.person import Person
from app.models.tool_material_item import ToolMaterialItem
from app.models.tool_material_settings import ToolMaterialSettings
from app.models.user import User
from app.services.tool_material_responsibility_service import (
    ToolMaterialResponsibilityService,
    get_tool_responsible_user,
)
from app.services.user_service import UserService


def responsibility_db() -> Session:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return Session(engine)


def add_user(
    db: Session,
    *,
    username: str,
    display_name: str,
    role: UserRole = UserRole.OFFICE,
    is_active: bool = True,
    person_type: PersonType = PersonType.INTERNAL,
    person_active: bool = True,
    permissions: tuple[str, ...] = ("miscellaneous",),
) -> User:
    person = Person(
        first_name=display_name.split()[0],
        last_name=display_name.split()[-1],
        display_name=display_name,
        short_code=username[:8].upper(),
        person_type=person_type,
        is_active=person_active,
    )
    user = User(
        username=username,
        display_name=display_name,
        password_hash="x",
        role=role,
        is_active=is_active,
        office_page_permissions=list(permissions),
        person=person,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def test_responsible_user_can_be_selected_changed_reset_and_loaded_centrally():
    db = responsibility_db()
    first = add_user(db, username="anna", display_name="Anna Büro")
    second = add_user(db, username="berta", display_name="Berta Büro")
    service = ToolMaterialResponsibilityService(db)

    selected = service.update_responsible_user(first.id)
    assert selected.tool_responsible_user_id == first.id
    assert selected.responsible_user is not None
    assert selected.responsible_user.display_name == "Anna Büro"
    assert get_tool_responsible_user(db).id == first.id

    changed = service.update_responsible_user(second.id)
    assert changed.tool_responsible_user_id == second.id
    assert get_tool_responsible_user(db).id == second.id

    reset = service.update_responsible_user(None)
    assert reset.tool_responsible_user_id is None
    assert reset.responsible_user is None
    assert get_tool_responsible_user(db) is None


def test_selectable_users_require_active_internal_opted_in_office_account():
    db = responsibility_db()
    valid = add_user(db, username="valid", display_name="zeta Büro")
    earlier = add_user(db, username="earlier", display_name="Alpha Büro")
    add_user(
        db,
        username="external",
        display_name="Externe Büro",
        person_type=PersonType.EXTERNAL,
    )
    add_user(db, username="inactive", display_name="Inaktive Büro", is_active=False)
    add_user(db, username="person-off", display_name="Person Inaktiv", person_active=False)
    add_user(db, username="no-opt-in", display_name="Ohne Freigabe", permissions=())
    add_user(db, username="admin", display_name="Admin User", role=UserRole.ADMIN)
    add_user(db, username="manager", display_name="Projekt Leitung", role=UserRole.PROJECT_MANAGER)

    options = ToolMaterialResponsibilityService(db).list_selectable_users()

    assert [(option.id, option.display_name) for option in options] == [
        (earlier.id, "Alpha Büro"),
        (valid.id, "zeta Büro"),
    ]


def test_duplicate_names_are_stored_by_user_id_and_invalid_ids_are_rejected():
    db = responsibility_db()
    first = add_user(db, username="double-one", display_name="Doppelter Name")
    second = add_user(db, username="double-two", display_name="Doppelter Name")
    service = ToolMaterialResponsibilityService(db)

    service.update_responsible_user(second.id)

    settings = db.get(ToolMaterialSettings, 1)
    assert settings is not None
    assert settings.tool_responsible_user_id == second.id
    assert settings.tool_responsible_user_id != first.id

    try:
        service.update_responsible_user(999_999)
    except Exception as error:
        assert getattr(error, "status_code", None) == 400
    else:
        raise AssertionError("Ungültige Benutzer-ID wurde nicht abgewiesen.")


def test_no_longer_authorized_responsible_user_stays_visible_but_is_not_a_recipient():
    db = responsibility_db()
    responsible = add_user(db, username="responsible", display_name="Verantwortliche Büro")
    service = ToolMaterialResponsibilityService(db)
    service.update_responsible_user(responsible.id)

    responsible.office_page_permissions = []
    db.commit()

    settings = service.read_settings()
    assert settings.tool_responsible_user_id == responsible.id
    assert settings.responsible_user is not None
    assert settings.responsible_user.is_valid is False
    assert "keinen Zugriff" in settings.responsible_user.invalid_reason
    assert get_tool_responsible_user(db) is None


def test_deleting_responsible_user_clears_reference_without_touching_tools_or_messages():
    db = responsibility_db()
    admin = add_user(db, username="admin-delete", display_name="Admin Delete", role=UserRole.ADMIN)
    responsible = add_user(db, username="office-delete", display_name="Office Delete")
    item = ToolMaterialItem(beg_number="BEG-1", designation="Bohrmaschine")
    db.add(item)
    db.commit()
    ToolMaterialResponsibilityService(db).update_responsible_user(responsible.id)

    UserService(db).delete_user(responsible.id, admin.id)

    settings = db.get(ToolMaterialSettings, 1)
    assert settings is not None
    assert settings.tool_responsible_user_id is None
    assert db.scalar(select(func.count()).select_from(ToolMaterialItem)) == 1
    assert db.scalar(select(func.count()).select_from(DashboardMessageDismissal)) == 0
