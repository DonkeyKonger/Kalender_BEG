from datetime import UTC, date, datetime, timedelta
from typing import TypeVar

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import SessionLocal
from app.core.security import hash_password
from app.models.absence import Absence
from app.models.assignment import Assignment
from app.models.audit_log import AuditLog
from app.models.enums import (
    AbsenceStatus,
    AbsenceType,
    AssignmentType,
    PersonType,
    SiteStatus,
    UserRole,
    VehicleType,
)
from app.models.person import Person
from app.models.site import Site
from app.models.user import User
from app.models.vehicle import SiteVehicleAssignment, Vehicle
from app.seed_admin import seed_admin

T = TypeVar("T")


def monday_of_current_week() -> date:
    today = date.today()
    return today - timedelta(days=today.weekday())


def get_one(db: Session, model: type[T], **filters) -> T | None:
    statement = select(model).filter_by(**filters)
    return db.scalar(statement)


def get_or_create_person(
    db: Session,
    *,
    first_name: str,
    last_name: str,
    short_code: str,
    person_type: PersonType = PersonType.INTERNAL,
    is_active: bool = True,
    email: str | None = None,
    phone: str | None = None,
    notes: str | None = None,
) -> Person:
    person = get_one(db, Person, short_code=short_code)
    if person is not None:
        return person

    display_name = f"{first_name} {last_name}"
    person = Person(
        first_name=first_name,
        last_name=last_name,
        display_name=display_name,
        short_code=short_code,
        person_type=person_type,
        is_active=is_active,
        email=email,
        phone=phone,
        notes=notes,
    )
    db.add(person)
    db.flush()
    return person


def get_or_create_user(
    db: Session,
    *,
    username: str,
    display_name: str,
    role: UserRole,
    person: Person | None = None,
) -> User:
    if not settings.seed_default_password:
        raise RuntimeError("SEED_DEFAULT_PASSWORD muss gesetzt sein.")

    user = get_one(db, User, username=username)
    if user is not None:
        user.display_name = display_name
        user.password_hash = hash_password(settings.seed_default_password)
        user.role = role
        user.is_active = True
        user.person_id = person.id if person else None
        db.flush()
        return user

    user = User(
        username=username,
        display_name=display_name,
        password_hash=hash_password(settings.seed_default_password),
        role=role,
        is_active=True,
        person_id=person.id if person else None,
    )
    db.add(user)
    db.flush()
    return user


def get_or_create_site(
    db: Session,
    *,
    site_number: str,
    name: str,
    location: str,
    address: str,
    customer: str,
    project_manager: Person | None,
    status: SiteStatus = SiteStatus.ACTIVE,
    info: str | None = None,
    color: str | None = None,
    closed_by_user_id: int | None = None,
) -> Site:
    site = get_one(db, Site, site_number=site_number)
    if site is not None:
        return site

    site = Site(
        site_number=site_number,
        name=name,
        location=location,
        address=address,
        customer=customer,
        project_manager_person_id=project_manager.id if project_manager else None,
        status=status,
        info=info,
        color=color,
        closed_at=datetime.now(UTC) if status in {SiteStatus.COMPLETED, SiteStatus.DELETED} else None,
        closed_by_user_id=closed_by_user_id,
    )
    db.add(site)
    db.flush()
    return site


def get_or_create_assignment(
    db: Session,
    *,
    site: Site,
    person: Person,
    start_date: date,
    end_date: date,
    created_by_user_id: int,
    assignment_type: AssignmentType = AssignmentType.REGULAR,
    note: str | None = None,
) -> Assignment:
    statement = select(Assignment).filter_by(
        site_id=site.id,
        person_id=person.id,
        start_date=start_date,
        end_date=end_date,
        note=note,
    )
    assignment = db.scalar(statement)
    if assignment is not None:
        return assignment

    assignment = Assignment(
        site_id=site.id,
        person_id=person.id,
        start_date=start_date,
        end_date=end_date,
        assignment_type=assignment_type,
        note=note,
        created_by_user_id=created_by_user_id,
        updated_by_user_id=created_by_user_id,
    )
    db.add(assignment)
    db.flush()
    return assignment


def get_or_create_absence(
    db: Session,
    *,
    person: Person,
    absence_type: AbsenceType,
    start_date: date,
    end_date: date,
    created_by_user_id: int,
    note: str | None = None,
) -> Absence | None:
    statement = select(Absence).filter_by(
        person_id=person.id,
        absence_type=absence_type,
        start_date=start_date,
        end_date=end_date,
        note=note,
    )
    absence = db.scalar(statement)
    if absence is not None:
        return absence
    if seed_absence_was_changed_or_removed(
        db,
        person_id=person.id,
        absence_type=absence_type,
        start_date=start_date,
        end_date=end_date,
        note=note,
    ):
        return None

    absence = Absence(
        person_id=person.id,
        absence_type=absence_type,
        start_date=start_date,
        end_date=end_date,
        status=AbsenceStatus.ACTIVE,
        note=note,
        created_by_user_id=created_by_user_id,
        updated_by_user_id=created_by_user_id,
    )
    db.add(absence)
    db.flush()
    return absence


def seed_absence_was_changed_or_removed(
    db: Session,
    *,
    person_id: int,
    absence_type: AbsenceType,
    start_date: date,
    end_date: date,
    note: str | None,
) -> bool:
    signature = {
        "person_id": person_id,
        "absence_type": absence_type.value,
        "start_date": start_date.isoformat(),
        "end_date": end_date.isoformat(),
        "note": note,
    }
    statement = select(AuditLog.old_value_json).where(
        AuditLog.entity_type == "absence",
        AuditLog.action.in_(["absence.deleted", "absence.updated"]),
    )
    return any(absence_seed_signature_matches(old_value, signature) for old_value in db.scalars(statement))


def absence_seed_signature_matches(old_value: dict | None, signature: dict) -> bool:
    if not isinstance(old_value, dict):
        return False
    return all(old_value.get(key) == expected for key, expected in signature.items())


def get_or_create_vehicle(
    db: Session,
    *,
    license_plate: str,
    name: str,
    vehicle_type: VehicleType = VehicleType.VAN,
    is_active: bool = True,
    gps_vehicle_id: str | None = None,
    notes: str | None = None,
) -> Vehicle:
    vehicle = get_one(db, Vehicle, license_plate=license_plate)
    if vehicle is not None:
        return vehicle

    vehicle = Vehicle(
        license_plate=license_plate,
        name=name,
        vehicle_type=vehicle_type,
        is_active=is_active,
        gps_vehicle_id=gps_vehicle_id,
        notes=notes,
    )
    db.add(vehicle)
    db.flush()
    return vehicle


def get_or_create_site_vehicle_assignment(
    db: Session,
    *,
    site: Site,
    vehicle: Vehicle,
    start_date: date,
    end_date: date,
    note: str | None = None,
) -> SiteVehicleAssignment:
    statement = select(SiteVehicleAssignment).filter_by(
        site_id=site.id,
        vehicle_id=vehicle.id,
        start_date=start_date,
        end_date=end_date,
        note=note,
    )
    assignment = db.scalar(statement)
    if assignment is not None:
        return assignment

    assignment = SiteVehicleAssignment(
        site_id=site.id,
        vehicle_id=vehicle.id,
        start_date=start_date,
        end_date=end_date,
        note=note,
    )
    db.add(assignment)
    db.flush()
    return assignment


def add_seed_audit_log_once(
    db: Session,
    *,
    user_id: int,
    action: str,
    entity_type: str,
    new_value_json: dict,
) -> None:
    existing = db.scalar(select(AuditLog).filter_by(action=action, entity_type=entity_type))
    if existing is not None:
        return

    db.add(
        AuditLog(
            user_id=user_id,
            action=action,
            entity_type=entity_type,
            entity_id=None,
            old_value_json=None,
            new_value_json=new_value_json,
        )
    )


def seed_demo_data(db: Session) -> None:
    admin = seed_admin(db)
    week_start = monday_of_current_week()

    pm_lena = get_or_create_person(
        db,
        first_name="Lena",
        last_name="Hoffmann",
        short_code="Le. Ho.",
        email="lena.hoffmann@example.test",
        notes="Seed: Projektleitung, darf alle Baustellen bearbeiten.",
    )
    pm_tobias = get_or_create_person(
        db,
        first_name="Tobias",
        last_name="Krueger",
        short_code="To. Kr.",
        email="tobias.krueger@example.test",
        notes="Seed: zweite Projektleitung.",
    )
    office_mara = get_or_create_person(
        db,
        first_name="Mara",
        last_name="Seidel",
        short_code="Ma. Se.",
        email="mara.seidel@example.test",
        notes="Seed: Buero, lesender Planungszugriff.",
    )

    monteurs = {
        "noah": get_or_create_person(
            db, first_name="Noah", last_name="Stern", short_code="No. St."
        ),
        "jonas": get_or_create_person(
            db, first_name="Jonas", last_name="Feld", short_code="Jo. Fe."
        ),
        "emil": get_or_create_person(
            db, first_name="Emil", last_name="Weber", short_code="Em. We."
        ),
        "luis": get_or_create_person(
            db, first_name="Luis", last_name="Bauer", short_code="Lu. Ba."
        ),
        "paul": get_or_create_person(
            db, first_name="Paul", last_name="Brandt", short_code="Pa. Br."
        ),
        "ben": get_or_create_person(db, first_name="Ben", last_name="Kaiser", short_code="Be. Ka."),
        "inactive": get_or_create_person(
            db,
            first_name="Oskar",
            last_name="Winter",
            short_code="Os. Wi.",
            is_active=False,
            notes="Seed: deaktivierte Person fuer Blockierregel.",
        ),
    }
    external = get_or_create_person(
        db,
        first_name="Nico",
        last_name="Leihmann",
        short_code="Ni. Le.",
        person_type=PersonType.EXTERNAL,
        notes="Seed: regulaer gepflegte externe Kraft.",
    )
    external_temp = get_or_create_person(
        db,
        first_name="Temp",
        last_name="Kabelhilfe",
        short_code="Te. Ka.",
        person_type=PersonType.EXTERNAL_TEMP,
        notes="Seed: Beispiel fuer Schnelleingabe aus der Matrix.",
    )

    get_or_create_user(
        db,
        username="lena.hoffmann",
        display_name=pm_lena.display_name,
        role=UserRole.PROJECT_MANAGER,
        person=pm_lena,
    )
    get_or_create_user(
        db,
        username="tobias.krueger",
        display_name=pm_tobias.display_name,
        role=UserRole.PROJECT_MANAGER,
        person=pm_tobias,
    )
    get_or_create_user(
        db,
        username="mara.seidel",
        display_name=office_mara.display_name,
        role=UserRole.OFFICE,
        person=office_mara,
    )
    get_or_create_user(
        db,
        username="noah.stern",
        display_name=monteurs["noah"].display_name,
        role=UserRole.MONTEUR,
        person=monteurs["noah"],
    )
    get_or_create_user(
        db,
        username="jonas.feld",
        display_name=monteurs["jonas"].display_name,
        role=UserRole.MONTEUR,
        person=monteurs["jonas"],
    )
    get_or_create_user(
        db,
        username="emil.weber",
        display_name=monteurs["emil"].display_name,
        role=UserRole.MONTEUR,
        person=monteurs["emil"],
    )

    active_site = get_or_create_site(
        db,
        site_number="BP-2027-001",
        name="Wohnanlage Nordlicht",
        location="Hannover List",
        address="Podbielskistrasse 120, 30177 Hannover",
        customer="Musterbau Nord GmbH",
        project_manager=pm_lena,
        info="Hauptverteilung und Steigetrassen, Zugang ueber Baucontainer.",
        color="#2563eb",
    )
    second_site = get_or_create_site(
        db,
        site_number="BP-2027-002",
        name="Schule Am Park",
        location="Garbsen",
        address="Parkweg 14, 30823 Garbsen",
        customer="Stadt Garbsen",
        project_manager=pm_tobias,
        info="Sanierung in Bauabschnitten, Ferienfenster beachten.",
        color="#16a34a",
    )
    small_site = get_or_create_site(
        db,
        site_number="BP-2027-003",
        name="Praxis Lichtbogen",
        location="Laatzen",
        address="Marktplatz 7, 30880 Laatzen",
        customer="Praxisgemeinschaft Lichtbogen",
        project_manager=pm_lena,
        info="Umbau im laufenden Betrieb, Laermfenster absprechen.",
        color="#f97316",
    )
    paused_site = get_or_create_site(
        db,
        site_number="BP-2027-004",
        name="Logistikhalle Westtor",
        location="Seelze",
        address="Industriestrasse 22, 30926 Seelze",
        customer="Westtor Logistik AG",
        project_manager=pm_tobias,
        status=SiteStatus.PAUSED,
        info="Pausiert wegen Vorleistung Trockenbau.",
        color="#ca8a04",
    )
    closed_site = get_or_create_site(
        db,
        site_number="BP-2027-005",
        name="Altbau Linden Abschluss",
        location="Hannover Linden",
        address="Deisterstrasse 45, 30449 Hannover",
        customer="Hausverwaltung Lindenhof",
        project_manager=pm_lena,
        status=SiteStatus.COMPLETED,
        info="Abgeschlossen, bleibt fuer historische Suche erhalten.",
        color="#6b7280",
        closed_by_user_id=admin.id,
    )

    transporter = get_or_create_vehicle(
        db,
        license_plate="H-BP 1027",
        name="Transporter 1",
        notes="Seed: Standardfahrzeug fuer Baustelleneinsaetze.",
    )
    service_van = get_or_create_vehicle(
        db,
        license_plate="H-BP 2045",
        name="Servicewagen Nord",
        gps_vehicle_id="gps-demo-2045",
        notes="Seed: GPS-ID vorbereitet, noch ohne aktive Kopplung.",
    )
    pool_car = get_or_create_vehicle(
        db,
        license_plate="H-BP 3090",
        name="Poolfahrzeug",
        vehicle_type=VehicleType.CAR,
        notes="Seed: optionales Fahrzeug ohne komplexe Konfliktplanung.",
    )

    day_one = week_start
    day_two = week_start + timedelta(days=1)
    day_three = week_start + timedelta(days=2)
    day_four = week_start + timedelta(days=3)
    day_five = week_start + timedelta(days=4)
    next_monday = week_start + timedelta(days=7)

    get_or_create_assignment(
        db,
        site=active_site,
        person=monteurs["noah"],
        start_date=day_one,
        end_date=day_five,
        created_by_user_id=admin.id,
        note="Seed: mehrtaegiger Einsatz Mo-Fr.",
    )
    get_or_create_assignment(
        db,
        site=active_site,
        person=monteurs["jonas"],
        start_date=day_three,
        end_date=day_three,
        created_by_user_id=admin.id,
        note="Seed: erster Einsatz am Doppelbelegungstag.",
    )
    get_or_create_assignment(
        db,
        site=small_site,
        person=monteurs["jonas"],
        start_date=day_three,
        end_date=day_three,
        created_by_user_id=admin.id,
        assignment_type=AssignmentType.SUPPORT,
        note="Seed: zweiter erlaubter Einsatz am selben Tag.",
    )
    get_or_create_assignment(
        db,
        site=second_site,
        person=monteurs["emil"],
        start_date=day_two,
        end_date=day_four,
        created_by_user_id=admin.id,
        note="Seed: Einsatz mit paralleler Schul-Warnung am Donnerstag.",
    )
    get_or_create_assignment(
        db,
        site=active_site,
        person=external,
        start_date=day_two,
        end_date=day_five,
        created_by_user_id=admin.id,
        note="Seed: externer Leiharbeiter.",
    )
    get_or_create_assignment(
        db,
        site=small_site,
        person=external_temp,
        start_date=next_monday,
        end_date=next_monday + timedelta(days=2),
        created_by_user_id=admin.id,
        note="Seed: external_temp aus Schnelleingabe.",
    )

    get_or_create_absence(
        db,
        person=monteurs["luis"],
        absence_type=AbsenceType.VACATION,
        start_date=day_one,
        end_date=day_five,
        created_by_user_id=admin.id,
        note="Seed: Urlaub blockiert Einplanung hart.",
    )
    get_or_create_absence(
        db,
        person=monteurs["paul"],
        absence_type=AbsenceType.SICK,
        start_date=day_two,
        end_date=day_four,
        created_by_user_id=admin.id,
        note="Seed: Krankheit blockiert Einplanung hart.",
    )
    get_or_create_absence(
        db,
        person=monteurs["emil"],
        absence_type=AbsenceType.SCHOOL,
        start_date=day_four,
        end_date=day_four,
        created_by_user_id=admin.id,
        note="Seed: Schule erzeugt Warnung, nicht Blockade.",
    )
    get_or_create_absence(
        db,
        person=monteurs["ben"],
        absence_type=AbsenceType.FREE,
        start_date=next_monday,
        end_date=next_monday,
        created_by_user_id=admin.id,
        note="Seed: Frei erzeugt Warnung.",
    )
    get_or_create_absence(
        db,
        person=pm_tobias,
        absence_type=AbsenceType.OTHER,
        start_date=day_five,
        end_date=day_five,
        created_by_user_id=admin.id,
        note="Seed: Sonstiges als weicher Konflikt.",
    )

    get_or_create_site_vehicle_assignment(
        db,
        site=active_site,
        vehicle=transporter,
        start_date=day_one,
        end_date=day_five,
        note="Seed: Fahrzeug fuer Hauptbaustelle.",
    )
    get_or_create_site_vehicle_assignment(
        db,
        site=second_site,
        vehicle=service_van,
        start_date=day_two,
        end_date=day_four,
        note="Seed: Fahrzeug mit spaeterer GPS-Vorbereitung.",
    )
    get_or_create_site_vehicle_assignment(
        db,
        site=small_site,
        vehicle=pool_car,
        start_date=next_monday,
        end_date=next_monday,
        note="Seed: optionales Poolfahrzeug.",
    )

    add_seed_audit_log_once(
        db,
        user_id=admin.id,
        action="assignment.rejected.seed.third_assignment",
        entity_type="assignment",
        new_value_json={
            "reason": "Ein dritter Einsatz am selben Tag muss spaeter hart blockiert werden.",
            "person_short_code": monteurs["jonas"].short_code,
            "date": day_three.isoformat(),
            "attempted_site_number": paused_site.site_number,
        },
    )
    add_seed_audit_log_once(
        db,
        user_id=admin.id,
        action="assignment.rejected.seed.closed_site",
        entity_type="assignment",
        new_value_json={
            "reason": "Abgeschlossene Baustellen duerfen nicht normal beplant werden.",
            "site_number": closed_site.site_number,
            "person_short_code": monteurs["noah"].short_code,
            "date": next_monday.isoformat(),
        },
    )
    add_seed_audit_log_once(
        db,
        user_id=admin.id,
        action="assignment.rejected.seed.inactive_person",
        entity_type="assignment",
        new_value_json={
            "reason": "Deaktivierte Personen duerfen nicht eingeplant werden.",
            "person_short_code": monteurs["inactive"].short_code,
            "date": day_two.isoformat(),
        },
    )

    db.commit()


def main() -> None:
    with SessionLocal() as db:
        seed_demo_data(db)
    print("Seed-Daten bereit.")


if __name__ == "__main__":
    main()
