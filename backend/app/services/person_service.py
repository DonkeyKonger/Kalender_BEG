from datetime import date, datetime, timedelta, timezone

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.absence import Absence
from app.models.assignment import Assignment
from app.models.audit_log import AuditLog
from app.models.enums import PersonEmploymentStatus, PersonType, SiteLocationStatus
from app.models.gps_point import GpsPoint
from app.models.person import Person
from app.models.site import Site
from app.models.user import User
from app.repositories.person_repository import PersonRepository
from app.schemas.person import ExternalPersonCreate, PersonCreate, PersonMapItem, PersonMapProjectManager, PersonMapResponse, PersonUpdate
from app.services.audit_service import AuditService
from app.services.geo_service import has_valid_coordinates
from app.services.person_display import calendar_short_code, employee_short_code_from_values


REQUIRED_TEXT_FIELDS = {
    "first_name": "Vorname darf nicht leer sein.",
    "last_name": "Nachname darf nicht leer sein.",
    "display_name": "Anzeigename darf nicht leer sein.",
    "short_code": "Kuerzel darf nicht leer sein.",
}
OPTIONAL_TEXT_FIELDS = [
    "first_name",
    "last_name",
    "display_name",
    "short_code",
    "email",
    "phone",
    "address_postal_code",
    "address_city",
    "address_street",
    "address_house_number",
    "address_extra",
    "address_formatted",
    "notes",
]
ADDRESS_FIELDS = {
    "address_postal_code",
    "address_city",
    "address_street",
    "address_house_number",
    "address_extra",
}
TECHNICAL_LOCATION_FIELDS = {"address_latitude", "address_longitude", "address_location_status"}
VALID_MAP_LOCATION_STATUSES = {SiteLocationStatus.GEOCODED}
PERSON_LOCATION_DEPENDENCY_FIELDS = (
    "address_postal_code",
    "address_city",
    "address_street",
    "address_house_number",
    "address_extra",
    "address_formatted",
    "address_latitude",
    "address_longitude",
)
DELETED_PERSON_LABEL = "gelöscht"
EXTERNAL_INACTIVITY_DAYS = 62


class PersonService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.people = PersonRepository(db)
        self.audit = AuditService(db)

    def list_people(self, is_active: bool | None = None) -> list[Person]:
        if is_active is not False:
            self.deactivate_stale_external_people()
        return self.people.list(is_active=is_active)

    def person_map(self) -> PersonMapResponse:
        people = self.people.list(is_active=True)
        project_managers = self._last_project_manager_by_person(date.today())
        map_people = []
        missing_location = 0
        for person in people:
            if has_valid_person_map_location(person):
                map_people.append(person_map_item(person, project_managers.get(person.id)))
            else:
                missing_location += 1
        return PersonMapResponse(people=map_people, missing_location=missing_location)

    def create_person(self, payload: PersonCreate, user_id: int) -> Person:
        values = clean_person_values(payload.model_dump())
        apply_selected_person_geocode(values)
        person = Person(**values)
        self.people.add(person)
        self.db.flush()
        self.audit.record(
            user_id=user_id,
            action="person.created",
            entity_type="person",
            entity_id=person.id,
            old_value=None,
            new_value=person_snapshot(person),
        )
        self.db.commit()
        self.db.refresh(person)
        return person

    def create_external_person(self, payload: ExternalPersonCreate, user_id: int) -> Person:
        display_name = payload.display_name.strip()
        if not display_name:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Name darf nicht leer sein.")

        existing = self.people.find_active_external_by_display_name(display_name)
        if existing is not None:
            return existing

        person = Person(**external_person_values(display_name))
        self.people.add(person)
        self.db.flush()
        self.audit.record(
            user_id=user_id,
            action="person.external.created",
            entity_type="person",
            entity_id=person.id,
            old_value=None,
            new_value=person_snapshot(person),
        )
        self.db.commit()
        self.db.refresh(person)
        return person

    def update_person(self, person_id: int, payload: PersonUpdate, user_id: int) -> Person:
        person = self.people.get(person_id)
        if person is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Person nicht gefunden.")
        values = clean_person_values(payload.model_dump(exclude_unset=True))
        old_value = person_snapshot(person)
        address_changed = any(
            field in values and getattr(person, field) != values[field]
            for field in ADDRESS_FIELDS
        )
        selected_geocode = apply_selected_person_geocode(values)
        for field, value in values.items():
            setattr(person, field, value)
        if address_changed and not selected_geocode:
            person.address_latitude = None
            person.address_longitude = None
            person.address_location_status = SiteLocationStatus.UNCHECKED
        self.audit.record(
            user_id=user_id,
            action="person.updated",
            entity_type="person",
            entity_id=person.id,
            old_value=old_value,
            new_value=person_snapshot(person),
        )
        self.db.commit()
        self.db.refresh(person)
        return person

    def remove_plan(self, person_id: int) -> str:
        person = self.people.get(person_id)
        if person is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Person nicht gefunden.")
        return "delete"

    def remove_person(self, person_id: int, user_id: int) -> tuple[str, Person | None]:
        person = self.people.get(person_id)
        if person is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Person nicht gefunden.")
        self._soft_delete_person(person, user_id)
        return "deleted", None

    def delete_person(self, person_id: int, user_id: int) -> None:
        person = self.people.get(person_id)
        if person is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Person nicht gefunden.")
        self._soft_delete_person(person, user_id)

    def _deactivate_person(self, person: Person, user_id: int) -> Person:
        if not person.is_active:
            return person
        old_value = person_snapshot(person)
        person.is_active = False
        person.employment_status = PersonEmploymentStatus.DEPARTED
        self.audit.record(
            user_id=user_id,
            action="person.deactivated",
            entity_type="person",
            entity_id=person.id,
            old_value=old_value,
            new_value=person_snapshot(person),
        )
        self.db.commit()
        self.db.refresh(person)
        return person

    def _soft_delete_person(self, person: Person, user_id: int) -> Person:
        old_value = person_snapshot(person)
        deleted_at = datetime.now(timezone.utc)
        archive_key = f"archiv-{person.id}"
        archive_suffix = f" (archiviert #{person.id})"
        previous_display_name = person.display_name.strip() or f"{person.first_name} {person.last_name}".strip() or DELETED_PERSON_LABEL
        archived_display_name = f"{previous_display_name[:200 - len(archive_suffix)]}{archive_suffix}"
        person.first_name = DELETED_PERSON_LABEL
        person.last_name = archive_key
        person.display_name = archived_display_name
        person.short_code = archive_key
        person.is_active = False
        person.employment_status = PersonEmploymentStatus.DEPARTED
        person.can_sign_measurements_immediately = False
        person.email = None
        person.phone = None
        person.address_postal_code = None
        person.address_city = None
        person.address_street = None
        person.address_house_number = None
        person.address_extra = None
        person.address_formatted = None
        person.address_latitude = None
        person.address_longitude = None
        person.address_location_status = SiteLocationStatus.UNCHECKED
        person.company_phone_device_id = None
        person.notes = None
        person.deleted_at = deleted_at
        self.audit.record(
            user_id=user_id,
            action="person.deleted",
            entity_type="person",
            entity_id=person.id,
            old_value=old_value,
            new_value=person_snapshot(person),
        )
        self.db.commit()
        self.db.refresh(person)
        return person

    def _person_has_dependencies(self, person: Person) -> bool:
        if any(getattr(person, field, None) not in (None, "") for field in PERSON_LOCATION_DEPENDENCY_FIELDS):
            return True
        return (
            self._person_has_hard_delete_references(person)
            or self._has_row(
                AuditLog,
                AuditLog.entity_type == "person",
                AuditLog.entity_id == person.id,
                AuditLog.action != "person.created",
            )
        )

    def _person_has_hard_delete_references(self, person: Person) -> bool:
        return (
            self._has_row(Assignment, Assignment.person_id == person.id)
            or self._has_row(Absence, Absence.person_id == person.id)
            or self._has_row(User, User.person_id == person.id)
            or self._has_row(Site, Site.project_manager_person_id == person.id)
            or self._has_row(GpsPoint, GpsPoint.person_id == person.id)
        )

    def _has_row(self, model, *criteria) -> bool:
        statement = select(model.id).where(*criteria).limit(1)
        return self.db.scalar(statement) is not None

    def deactivate_stale_external_people(self) -> None:
        cutoff_date = date.today() - timedelta(days=EXTERNAL_INACTIVITY_DAYS)
        cutoff_datetime = datetime.now(timezone.utc) - timedelta(days=EXTERNAL_INACTIVITY_DAYS)
        recent_external_person_ids = select(Assignment.person_id).where(
            Assignment.end_date >= cutoff_date,
        )
        statement = select(Person).where(
            Person.deleted_at.is_(None),
            Person.is_active.is_(True),
            Person.person_type.in_([PersonType.EXTERNAL, PersonType.EXTERNAL_TEMP]),
            Person.created_at < cutoff_datetime,
            ~Person.id.in_(recent_external_person_ids),
        )
        stale_people = list(self.db.scalars(statement))
        if not stale_people:
            return
        for person in stale_people:
            old_value = person_snapshot(person)
            person.is_active = False
            person.employment_status = PersonEmploymentStatus.DEPARTED
            self.audit.record(
                user_id=None,
                action="person.external.auto_deactivated",
                entity_type="person",
                entity_id=person.id,
                old_value=old_value,
                new_value=person_snapshot(person),
            )
        self.db.commit()

    def _last_project_manager_by_person(self, day: date) -> dict[int, Person]:
        statement = (
            select(Assignment)
            .options(selectinload(Assignment.site).selectinload(Site.project_manager))
            .where(Assignment.start_date <= day)
            .order_by(Assignment.person_id, Assignment.end_date.desc(), Assignment.start_date.desc(), Assignment.id.desc())
        )
        result: dict[int, Person] = {}
        for assignment in self.db.scalars(statement):
            if assignment.person_id in result:
                continue
            manager = assignment.site.project_manager if assignment.site else None
            if manager is not None:
                result[assignment.person_id] = manager
        return result


def clean_person_values(values: dict) -> dict:
    cleaned = dict(values)
    for field in OPTIONAL_TEXT_FIELDS:
        if isinstance(cleaned.get(field), str):
            cleaned[field] = cleaned[field].strip() or None
    if not cleaned.get("display_name") and cleaned.get("first_name") and cleaned.get("last_name"):
        cleaned["display_name"] = f"{cleaned['first_name']} {cleaned['last_name']}"
    if cleaned.get("display_name") or (cleaned.get("first_name") and cleaned.get("last_name")) or cleaned.get("short_code"):
        cleaned["short_code"] = employee_short_code_from_values(
            first_name=cleaned.get("first_name"),
            last_name=cleaned.get("last_name"),
            display_name=cleaned.get("display_name"),
            short_code=cleaned.get("short_code"),
        )
    for field, message in REQUIRED_TEXT_FIELDS.items():
        if field in cleaned and not cleaned.get(field):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, message)
    sync_person_employment_status(cleaned)
    return cleaned


def sync_person_employment_status(values: dict) -> None:
    if "employment_status" in values:
        values["is_active"] = values["employment_status"] == PersonEmploymentStatus.ACTIVE
        return
    if "is_active" in values:
        values["employment_status"] = (
            PersonEmploymentStatus.ACTIVE
            if values["is_active"]
            else PersonEmploymentStatus.DEPARTED
        )


def external_person_values(display_name: str) -> dict:
    parts = [part for part in display_name.replace(",", " ").split() if part]
    first_name = parts[0] if parts else display_name
    last_name = parts[-1] if len(parts) >= 2 else first_name
    return {
        "first_name": first_name,
        "last_name": last_name,
        "display_name": display_name,
        "short_code": f"{first_name[:1]}.{last_name}",
        "person_type": PersonType.EXTERNAL_TEMP,
        "is_active": True,
        "employment_status": PersonEmploymentStatus.ACTIVE,
        "notes": "Aus Matrix-Schnelleingabe erzeugt.",
    }


def person_snapshot(person: Person) -> dict:
    deleted_at = getattr(person, "deleted_at", None)
    return {
        "id": person.id,
        "first_name": person.first_name,
        "last_name": person.last_name,
        "display_name": person.display_name,
        "short_code": person.short_code,
        "person_type": person.person_type.value,
        "is_active": person.is_active,
        "employment_status": getattr(person, "employment_status", PersonEmploymentStatus.ACTIVE).value,
        "can_sign_measurements_immediately": getattr(person, "can_sign_measurements_immediately", False),
        "annual_vacation_days": getattr(person, "annual_vacation_days", None),
        "deleted_at": deleted_at.isoformat() if deleted_at else None,
        "email": person.email,
        "phone": person.phone,
        "address_postal_code": getattr(person, "address_postal_code", None),
        "address_city": getattr(person, "address_city", None),
        "address_street": getattr(person, "address_street", None),
        "address_house_number": getattr(person, "address_house_number", None),
        "address_extra": getattr(person, "address_extra", None),
        "address_formatted": getattr(person, "address_formatted", None),
        "address_latitude": getattr(person, "address_latitude", None),
        "address_longitude": getattr(person, "address_longitude", None),
        "address_location_status": getattr(person, "address_location_status", SiteLocationStatus.UNCHECKED).value,
        "notes": person.notes,
    }


def has_valid_person_map_location(person: Person) -> bool:
    return (
        person.address_latitude is not None
        and person.address_longitude is not None
        and person.address_location_status in VALID_MAP_LOCATION_STATUSES
    )


def person_map_item(person: Person, project_manager: Person | None) -> PersonMapItem:
    return PersonMapItem(
        id=person.id,
        display_name=person.display_name,
        short_name=calendar_short_code(person),
        role=person.person_type,
        project_manager_assignment=PersonMapProjectManager.model_validate(project_manager) if project_manager else None,
        address_city=person.address_city,
        address_postal_code=person.address_postal_code,
        address_formatted=person.address_formatted,
        address_latitude=person.address_latitude,
        address_longitude=person.address_longitude,
        address_location_status=person.address_location_status,
        active=person.is_active,
    )


def apply_selected_person_geocode(values: dict) -> bool:
    if values.get("address_location_status") == SiteLocationStatus.GEOCODED and has_valid_coordinates(
        CoordinateDraft(values.get("address_latitude"), values.get("address_longitude"))
    ):
        return True
    had_location_status = "address_location_status" in values
    for field in TECHNICAL_LOCATION_FIELDS:
        values.pop(field, None)
    if had_location_status:
        values["address_location_status"] = SiteLocationStatus.UNCHECKED
    return False


class CoordinateDraft:
    def __init__(self, latitude: float | None, longitude: float | None) -> None:
        self.latitude = latitude
        self.longitude = longitude
