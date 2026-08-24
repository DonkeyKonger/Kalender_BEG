from datetime import UTC, date, datetime

from fastapi import HTTPException
import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.models import Base
from app.models.assignment import Assignment
from app.models.enums import UserRole
from app.models.extra_work_ticket import ExtraWorkTicket, ExtraWorkTicketEntry
from app.models.person import Person
from app.models.site import Site
from app.models.user import User
from app.schemas.extra_work import (
    ExtraWorkMaterialItem,
    ExtraWorkSignaturePoint,
    ExtraWorkTicketCreate,
    ExtraWorkTicketDetailsUpdate,
    ExtraWorkTicketDocumentEntryUpdate,
    ExtraWorkTicketDocumentUpdate,
    ExtraWorkTicketEntryPayload,
    ExtraWorkWorkerHours,
)
from app.services.extra_work_service import ExtraWorkService
from app.services.extra_work_remarks import extra_work_remarks_fit


def db_session() -> Session:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return Session(engine)


def office_user(username: str = "office") -> User:
    return User(
        username=username,
        display_name="Büro Test",
        password_hash="x",
        role=UserRole.OFFICE,
        office_page_permissions=["sites"],
    )


def _overflowing_legacy_remarks() -> str:
    words: list[str] = []
    while extra_work_remarks_fit(" ".join([*words, "Test"])):
        words.append("Test")
    return " ".join([*words, "Test"])


def test_document_rejects_new_remarks_overflow_but_preserves_unchanged_legacy_text():
    db = db_session()
    site = Site(site_number="8015", name="Projekt")
    actor = office_user()
    ticket = ExtraWorkTicket(
        site=site,
        sequence_number=1,
        display_number="8015.SZ01",
        kind="billing",
        status="draft",
        created_by=actor,
    )
    legacy_remarks = _overflowing_legacy_remarks()
    entry = ExtraWorkTicketEntry(
        ticket=ticket,
        site=site,
        component="BT A",
        floor="EG",
        remarks=legacy_remarks,
        worker_rows=[],
    )
    db.add_all([site, actor, ticket, entry])
    db.commit()
    service = ExtraWorkService(db)

    preserved = service.update_site_ticket_document(
        site_id=site.id,
        ticket_id=ticket.id,
        current_user=actor,
        payload=ExtraWorkTicketDocumentUpdate(
            title="Andere Korrektur",
            entry=ExtraWorkTicketDocumentEntryUpdate(
                component="BT A",
                floor="EG",
                remarks=legacy_remarks,
            ),
        ),
    )
    assert preserved.entry is not None
    assert preserved.entry.remarks == legacy_remarks

    with pytest.raises(HTTPException, match="Maximale Länge") as error:
        service.update_site_ticket_document(
            site_id=site.id,
            ticket_id=ticket.id,
            current_user=actor,
            payload=ExtraWorkTicketDocumentUpdate(
                entry=ExtraWorkTicketDocumentEntryUpdate(
                    component="BT A",
                    floor="EG",
                    remarks=f"{legacy_remarks} W",
                ),
            ),
        )

    assert error.value.status_code == 422
    assert db.get(ExtraWorkTicketEntry, entry.id).remarks == legacy_remarks


def test_site_create_uses_locked_site_sequence_and_mobile_kind_default(monkeypatch):
    db = db_session()
    site = Site(
        site_number="8015",
        name="FFW Barmbeck Hamburg",
        requires_extra_work_approval=True,
    )
    actor = office_user()
    db.add_all([site, actor])
    db.commit()
    service = ExtraWorkService(db)
    original_get_site = service._get_site
    lock_calls: list[bool] = []

    def tracked_get_site(site_id: int, *, for_update: bool = False):
        lock_calls.append(for_update)
        return original_get_site(site_id, for_update=for_update)

    monkeypatch.setattr(service, "_get_site", tracked_get_site)

    first = service.create_site_ticket(
        site_id=site.id,
        current_user=actor,
        payload=ExtraWorkTicketCreate(),
    )
    second = service.create_site_ticket(
        site_id=site.id,
        current_user=actor,
        payload=ExtraWorkTicketCreate(),
    )

    assert lock_calls == [True, True]
    assert (first.sequence_number, second.sequence_number) == (1, 2)
    assert (first.display_number, second.display_number) == ("8015.Z01", "8015.Z02")
    assert first.kind == second.kind == "approval"
    assert first.status == "draft"
    assert first.created_by_user_id == actor.id
    assert first.site_id == site.id


def test_site_create_continues_after_legacy_number_without_renaming_history():
    db = db_session()
    site = Site(site_number="8015", name="Projekt")
    actor = office_user()
    legacy = ExtraWorkTicket(
        site=site,
        sequence_number=15,
        display_number="8015.SZ15",
        kind="billing",
        status="draft",
    )
    db.add_all([site, actor, legacy])
    db.commit()

    created = ExtraWorkService(db).create_site_ticket(
        site_id=site.id,
        current_user=actor,
        payload=ExtraWorkTicketCreate(),
    )

    assert created.sequence_number == 16
    assert created.display_number == "8015.Z16"
    assert db.get(ExtraWorkTicket, legacy.id).display_number == "8015.SZ15"


def test_site_create_handles_gaps_and_mixed_legacy_current_display_numbers():
    db = db_session()
    site = Site(site_number="8015", name="Projekt")
    actor = office_user()
    tickets = [
        ExtraWorkTicket(
            site=site,
            sequence_number=3,
            display_number="8015.SZ15",
            kind="billing",
            status="draft",
        ),
        ExtraWorkTicket(
            site=site,
            sequence_number=7,
            display_number="8015.Z17",
            kind="billing",
            status="draft",
        ),
        ExtraWorkTicket(
            site=site,
            sequence_number=9,
            display_number="8015.AZ99",
            kind="billing",
            status="draft",
        ),
    ]
    db.add_all([site, actor, *tickets])
    db.commit()

    created = ExtraWorkService(db).create_site_ticket(
        site_id=site.id,
        current_user=actor,
        payload=ExtraWorkTicketCreate(),
    )

    assert created.sequence_number == 18
    assert created.display_number == "8015.Z18"


def test_site_create_rejects_missing_project_number():
    db = db_session()
    site = Site(site_number=None, name="Projekt ohne Nummer")
    actor = office_user()
    db.add_all([site, actor])
    db.commit()

    with pytest.raises(HTTPException) as error:
        ExtraWorkService(db).create_site_ticket(
            site_id=site.id,
            current_user=actor,
            payload=ExtraWorkTicketCreate(),
        )

    assert error.value.status_code == 409
    assert "Projektnummer" in error.value.detail


def test_ticket_customer_is_snapshotted_overridable_and_does_not_change_site_customer():
    db = db_session()
    site = Site(site_number="8015", name="Projekt", customer="Firma A")
    actor = office_user()
    db.add_all([site, actor])
    db.commit()
    service = ExtraWorkService(db)

    created = service.create_site_ticket(
        site_id=site.id,
        current_user=actor,
        payload=ExtraWorkTicketCreate(),
    )

    assert created.customer_name == "Firma A"
    updated = service.update_site_ticket_document(
        site_id=site.id,
        ticket_id=created.id,
        current_user=actor,
        payload=ExtraWorkTicketDocumentUpdate(customer_name="  Firma B  "),
    )

    assert updated.ticket.customer_name == "Firma B"
    assert service.get_site_ticket_document(
        site_id=site.id,
        ticket_id=created.id,
    ).ticket.customer_name == "Firma B"
    legacy_client_update = service.update_site_ticket_document(
        site_id=site.id,
        ticket_id=created.id,
        current_user=actor,
        payload=ExtraWorkTicketDocumentUpdate(title="Alte Client-Version"),
    )
    assert legacy_client_update.ticket.customer_name == "Firma B"
    assert db.get(Site, site.id).customer == "Firma A"


def test_document_reuses_eager_loaded_first_entry_without_a_second_entry_query():
    db = db_session()
    site = Site(site_number="8015", name="Projekt")
    ticket = ExtraWorkTicket(
        site=site,
        sequence_number=1,
        display_number="8015.SZ01",
        kind="billing",
        status="draft",
    )
    first_entry = ExtraWorkTicketEntry(
        ticket=ticket,
        site=site,
        component="Erster Eintrag",
        floor="EG",
        worker_rows=[],
    )
    second_entry = ExtraWorkTicketEntry(
        ticket=ticket,
        site=site,
        component="Zweiter Eintrag",
        floor="1. OG",
        worker_rows=[],
    )
    db.add_all([site, ticket, first_entry, second_entry])
    db.commit()
    site_id = site.id
    ticket_id = ticket.id
    first_entry_id = first_entry.id
    db.expire_all()

    select_statements: list[str] = []

    def record_select(
        _connection,
        _cursor,
        statement,
        _parameters,
        _context,
        _executemany,
    ):
        if statement.lstrip().upper().startswith("SELECT"):
            select_statements.append(statement)

    engine = db.get_bind()
    event.listen(engine, "before_cursor_execute", record_select)
    try:
        document = ExtraWorkService(db).get_site_ticket_document(
            site_id=site_id,
            ticket_id=ticket_id,
        )
    finally:
        event.remove(engine, "before_cursor_execute", record_select)

    assert document.entry is not None
    assert document.entry.id == first_entry_id
    assert sum("FROM extra_work_ticket_entries" in sql for sql in select_statements) == 1


def test_document_put_persists_form_updates_first_entry_and_keeps_legacy_entry():
    db = db_session()
    person = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
    )
    site = Site(site_number="8015", name="FFW Barmbeck Hamburg", customer="Bredow GmbH")
    actor = office_user()
    db.add_all([person, site, actor])
    db.commit()
    service = ExtraWorkService(db)
    ticket = service.create_site_ticket(
        site_id=site.id,
        current_user=actor,
        payload=ExtraWorkTicketCreate(),
    )
    first_entry = ExtraWorkTicketEntry(
        ticket_id=ticket.id,
        site_id=site.id,
        component="Alt",
        floor="EG",
        worker_rows=[],
    )
    legacy_second = ExtraWorkTicketEntry(
        ticket_id=ticket.id,
        site_id=site.id,
        component="Historisch",
        floor="1. OG",
        remarks="Nicht verändern",
        worker_rows=[{"worker_name": "Alt", "monday_hours": 1}],
    )
    db.add_all([first_entry, legacy_second])
    db.commit()
    first_id = first_entry.id
    second_id = legacy_second.id

    document = service.update_site_ticket_document(
        site_id=site.id,
        ticket_id=ticket.id,
        current_user=actor,
        payload=ExtraWorkTicketDocumentUpdate(
            title="Brandschott",
            customer_name="Muster Generalunternehmer GmbH",
            ordered_by_name="Herr Mustermann",
            ordered_by_company="Bredow GmbH",
            billing_type="unit_price",
            estimated_order_value=1250.5,
            material_required=True,
            material_separate_attachment=True,
            executed_by_lead_monteur=True,
            executed_by_monteur=True,
            executed_by_helper=False,
            executor_other_name="Erika Elektro",
            work_description="  Zeile eins\r\nZeile zwei  ",
            manual_order_date=date(2026, 8, 19),
            manual_execution_week=34,
            manual_execution_week_year=2026,
            manual_execution_start=date(2026, 8, 17),
            manual_execution_end=date(2026, 8, 20),
            entry=ExtraWorkTicketDocumentEntryUpdate(
                component="BT A",
                floor="2. OG",
                room_number="203",
                axis="A-4",
                remarks="Erste Zeile\r\nZweite Zeile",
                material_text="Kabelrinne",
                estimated_hours=8.5,
                worker_rows=[
                    ExtraWorkWorkerHours(
                        person_id=person.id,
                        worker_name="Max Monteur",
                        monday_hours=2,
                        monday_surcharge_25_hours=1.5,
                        monday_surcharge_50_hours=0.5,
                    )
                ],
            ),
        ),
    )

    assert document.ticket.work_description == "  Zeile eins\nZeile zwei  "
    assert document.ticket.customer_name == "Muster Generalunternehmer GmbH"
    assert document.ticket.billing_type == "unit_price"
    assert document.ticket.manual_execution_week is None
    assert document.ticket.manual_execution_week_year is None
    assert document.ticket.manual_execution_start == date(2026, 8, 17)
    assert document.ticket.manual_execution_end == date(2026, 8, 20)
    assert document.resolved_dates.order_date == date(2026, 8, 19)
    assert document.resolved_dates.approval_date == ticket.created_at.date()
    assert document.resolved_dates.execution_start == date(2026, 8, 17)
    assert document.resolved_dates.execution_end == date(2026, 8, 20)
    assert document.entry is not None
    assert document.entry.id == first_id
    assert document.entry.total_hours == 4
    assert document.entry.worker_rows[0].person_id == person.id
    assert document.entry.worker_rows[0].monday_surcharge_25_hours == 1.5
    assert document.ticket.total_hours == 5

    unchanged_second = db.get(ExtraWorkTicketEntry, second_id)
    assert unchanged_second is not None
    assert unchanged_second.component == "Historisch"
    assert unchanged_second.remarks == "Nicht verändern"
    assert db.query(ExtraWorkTicketEntry).filter_by(ticket_id=ticket.id).count() == 2


def test_document_membership_locks_archive_and_submitted_editability():
    db = db_session()
    site = Site(site_number="8015", name="Projekt")
    other_site = Site(site_number="9001", name="Fremdprojekt")
    actor = office_user()
    db.add_all([site, other_site, actor])
    db.commit()
    service = ExtraWorkService(db)
    ticket = service.create_site_ticket(
        site_id=site.id,
        current_user=actor,
        payload=ExtraWorkTicketCreate(),
    )
    update = ExtraWorkTicketDocumentUpdate(title="Korrektur")

    with pytest.raises(HTTPException) as wrong_site:
        service.get_site_ticket_document(site_id=other_site.id, ticket_id=ticket.id)
    assert wrong_site.value.status_code == 404

    stored = db.get(ExtraWorkTicket, ticket.id)
    assert stored is not None
    stored.status = "submitted"
    db.commit()
    submitted = service.update_site_ticket_document(
        site_id=site.id,
        ticket_id=ticket.id,
        current_user=actor,
        payload=update,
    )
    assert submitted.ticket.title == "Korrektur"

    stored.status = "signed"
    db.commit()
    with pytest.raises(HTTPException) as signed:
        service.update_site_ticket_document(
            site_id=site.id,
            ticket_id=ticket.id,
            current_user=actor,
            payload=update,
        )
    assert signed.value.status_code == 409

    stored.status = "draft"
    db.commit()
    service.delete_site_ticket(site_id=site.id, ticket_id=ticket.id, current_user=actor)
    archived = service.get_site_ticket_document(
        site_id=site.id,
        ticket_id=ticket.id,
        include_deleted=True,
    )
    assert archived.ticket.deleted_at is not None
    with pytest.raises(HTTPException) as archived_update:
        service.update_site_ticket_document(
            site_id=site.id,
            ticket_id=ticket.id,
            current_user=actor,
            payload=update,
        )
    assert archived_update.value.status_code == 404


def test_document_response_contains_signatures_without_bloating_ticket_read():
    db = db_session()
    site = Site(site_number="8015", name="Projekt")
    actor = office_user()
    db.add_all([site, actor])
    db.commit()
    service = ExtraWorkService(db)
    ticket = service.create_site_ticket(
        site_id=site.id,
        current_user=actor,
        payload=ExtraWorkTicketCreate(),
    )
    signed_at = datetime(2026, 8, 19, 10, 30, tzinfo=UTC)
    stored = db.get(ExtraWorkTicket, ticket.id)
    assert stored is not None
    stored.worker_signature_name = "Max Monteur"
    stored.worker_signature_place = "Bad Rothenfelde"
    stored.worker_signature_date = date(2026, 8, 18)
    stored.worker_signed_at = signed_at
    stored.worker_signature_strokes = [[{"x": 0.1, "y": 0.2}, {"x": 0.8, "y": 0.7}]]
    stored.customer_signature_type = "billing_customer"
    stored.customer_signature_name = "Kunde Beispiel"
    stored.customer_signature_place = "Hamburg"
    stored.customer_signed_at = signed_at
    stored.customer_signature_strokes = [[{"x": 0.2, "y": 0.3}, {"x": 0.9, "y": 0.6}]]
    db.commit()

    document = service.get_site_ticket_document(site_id=site.id, ticket_id=ticket.id)

    assert document.worker_signature.name == "Max Monteur"
    assert document.worker_signature.place == "Bad Rothenfelde"
    assert document.worker_signature.date == date(2026, 8, 18)
    assert document.worker_signature.signed_at is not None
    assert document.worker_signature.signed_at.replace(tzinfo=UTC) == signed_at
    assert document.worker_signature.strokes is not None
    assert document.worker_signature.strokes[0][1].x == 0.8
    assert document.customer_signature.type == "billing_customer"
    assert document.customer_signature.name == "Kunde Beispiel"
    assert document.customer_signature.place == "Hamburg"
    assert document.customer_signature.signed_at is not None
    assert document.customer_signature.signed_at.replace(tzinfo=UTC) == signed_at
    assert document.customer_signature.strokes is not None
    assert document.customer_signature.strokes[0][0].y == 0.3
    ticket_payload = document.ticket.model_dump()
    assert "worker_signature" not in ticket_payload
    assert "customer_signature" not in ticket_payload
    assert "worker_signature_strokes" not in ticket_payload
    assert "customer_signature_strokes" not in ticket_payload


def test_desktop_worker_signature_uses_shared_strokes_and_persists_place_and_date():
    db = db_session()
    site = Site(
        site_number="8015",
        name="Projekt",
        street="Am Kurpark",
        house_number="1",
        postal_code="49214",
        city="Bad Rothenfelde",
    )
    actor = office_user()
    db.add_all([site, actor])
    db.commit()
    service = ExtraWorkService(db)
    ticket = service.create_site_ticket(
        site_id=site.id,
        current_user=actor,
        payload=ExtraWorkTicketCreate(),
    )

    saved = service.update_site_ticket_document(
        site_id=site.id,
        ticket_id=ticket.id,
        current_user=actor,
        payload=ExtraWorkTicketDocumentUpdate(
            worker_signature_name=" Max Monteur ",
            worker_signature_place=" Bad Rothenfelde ",
            worker_signature_date=date(2026, 8, 19),
            worker_signature_strokes=[[
                ExtraWorkSignaturePoint(x=0.1, y=0.2),
                ExtraWorkSignaturePoint(x=0.8, y=0.7),
            ]],
        ),
    )

    stored = db.get(ExtraWorkTicket, ticket.id)
    assert stored is not None
    assert stored.worker_signature_name == "Max Monteur"
    assert stored.worker_signature_place == "Bad Rothenfelde"
    assert stored.worker_signature_date == date(2026, 8, 19)
    assert stored.worker_signed_at is not None
    assert stored.worker_signature_strokes == [[{"x": 0.1, "y": 0.2}, {"x": 0.8, "y": 0.7}]]
    assert saved.worker_signature.name == "Max Monteur"
    assert saved.worker_signature.place == "Bad Rothenfelde"
    assert saved.worker_signature.date == date(2026, 8, 19)
    assert saved.worker_signature.strokes is not None


def test_office_person_assignment_is_not_used_for_document_dates():
    db = db_session()
    person = Person(
        first_name="Büro",
        last_name="Person",
        display_name="Büro Person",
        short_code="BP",
    )
    site = Site(site_number="8015", name="Projekt", city="Hamburg")
    actor = office_user("office-with-person")
    actor.person = person
    db.add_all([site, actor])
    db.commit()
    db.add(
        Assignment(
            person_id=person.id,
            site_id=site.id,
            start_date=date(2026, 8, 3),
            end_date=date(2026, 8, 7),
        )
    )
    db.commit()
    service = ExtraWorkService(db)
    ticket = service.create_site_ticket(
        site_id=site.id,
        current_user=actor,
        payload=ExtraWorkTicketCreate(kind="approval"),
    )
    stored = db.get(ExtraWorkTicket, ticket.id)
    assert stored is not None
    stored.created_at = datetime(2026, 8, 19, 10, 0, tzinfo=UTC)
    stored.manual_order_date = date(2026, 8, 4)
    db.commit()

    document = service.get_site_ticket_document(site_id=site.id, ticket_id=ticket.id)

    assert document.resolved_dates.order_date == date(2026, 8, 4)
    assert document.resolved_dates.approval_date == date(2026, 8, 19)
    assert document.resolved_dates.approval_place == "Hamburg"
    assert document.resolved_dates.execution_start == date(2026, 8, 17)
    assert document.resolved_dates.execution_end == date(2026, 8, 23)


def test_legacy_mobile_entry_update_preserves_desktop_surcharges_and_resets_explicit_range():
    db = db_session()
    person = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
    )
    site = Site(site_number="8015", name="Projekt")
    user = User(
        username="max",
        display_name="Max Monteur",
        password_hash="x",
        role=UserRole.MONTEUR,
        person=person,
    )
    db.add_all([site, user])
    db.commit()
    assignment = Assignment(
        person_id=person.id,
        site_id=site.id,
        start_date=date(2026, 8, 17),
        end_date=date(2026, 8, 21),
    )
    db.add(assignment)
    db.commit()
    service = ExtraWorkService(db)
    ticket = service.create_mobile_ticket(
        assignment_id=assignment.id,
        current_user=user,
    )
    initial_document = service.get_site_ticket_document(
        site_id=site.id,
        ticket_id=ticket.id,
    )
    assert initial_document.resolved_dates.execution_start == date(2026, 8, 17)
    assert initial_document.resolved_dates.execution_end == date(2026, 8, 23)
    service.update_site_ticket_document(
        site_id=site.id,
        ticket_id=ticket.id,
        current_user=user,
        payload=ExtraWorkTicketDocumentUpdate(
            manual_execution_start=date(2026, 8, 17),
            manual_execution_end=date(2026, 8, 18),
            entry=ExtraWorkTicketDocumentEntryUpdate(
                component="BT A",
                floor="EG",
                remarks="Zeile eins\nZeile zwei",
                material_text="Material eins\nMaterial zwei",
                material_items=[
                    ExtraWorkMaterialItem(quantity=2, unit="x", description="Stiel US 5 bis 500")
                ],
                estimated_hours=8.5,
                worker_rows=[
                    ExtraWorkWorkerHours(
                        person_id=person.id,
                        worker_name="Max Monteur",
                        monday_hours=1,
                        monday_surcharge_25_hours=2,
                        monday_surcharge_50_hours=3,
                    )
                ],
            ),
        ),
    )

    service.upsert_mobile_ticket_entry(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=user,
        payload=ExtraWorkTicketEntryPayload(
            component="BT A geändert",
            floor="EG",
            remarks="  Zeile eins\r\nZeile zwei  ",
            material_text="  Material eins\r\nMaterial zwei  ",
            worker_rows=[
                ExtraWorkWorkerHours(worker_name="Max Monteur", monday_hours=4)
            ],
        ),
    )
    service.update_mobile_ticket_details(
        assignment_id=assignment.id,
        ticket_id=ticket.id,
        current_user=user,
        payload=ExtraWorkTicketDetailsUpdate(
            manual_execution_week=35,
            manual_execution_week_year=2026,
        ),
    )

    document = service.get_site_ticket_document(site_id=site.id, ticket_id=ticket.id)
    assert document.entry is not None
    row = document.entry.worker_rows[0]
    assert row.person_id == person.id
    assert row.monday_hours == 4
    assert row.monday_surcharge_25_hours == 2
    assert row.monday_surcharge_50_hours == 3
    assert document.entry.total_hours == 9
    assert document.entry.remarks == "  Zeile eins\nZeile zwei  "
    assert document.entry.material_text == "  Material eins\nMaterial zwei  "
    assert document.entry.material_items is not None
    assert document.entry.material_items[0].description == "Stiel US 5 bis 500"
    assert document.entry.estimated_hours == 8.5
    assert document.ticket.manual_execution_start is None
    assert document.ticket.manual_execution_end is None
    assert document.ticket.manual_execution_week == 35
    assert document.resolved_dates.execution_start == date(2026, 8, 24)
    assert document.resolved_dates.execution_end == date(2026, 8, 30)


def test_document_rejects_unknown_worker_and_more_than_24_hours_per_day():
    with pytest.raises(ValueError, match="maximal 24 Stunden"):
        ExtraWorkWorkerHours(
            worker_name="Max Monteur",
            monday_hours=12,
            monday_surcharge_25_hours=8,
            monday_surcharge_50_hours=5,
        )

    db = db_session()
    site = Site(site_number="8015", name="Projekt")
    actor = office_user()
    db.add_all([site, actor])
    db.commit()
    service = ExtraWorkService(db)
    ticket = service.create_site_ticket(
        site_id=site.id,
        current_user=actor,
        payload=ExtraWorkTicketCreate(),
    )
    with pytest.raises(HTTPException) as unknown_person:
        service.update_site_ticket_document(
            site_id=site.id,
            ticket_id=ticket.id,
            current_user=actor,
            payload=ExtraWorkTicketDocumentUpdate(
                entry=ExtraWorkTicketDocumentEntryUpdate(
                    worker_rows=[
                        ExtraWorkWorkerHours(
                            person_id=99999,
                            worker_name="Nicht vorhanden",
                        )
                    ]
                )
            ),
        )
    assert unknown_person.value.status_code == 422


def test_legacy_mobile_worker_merge_treats_payload_as_canonical_after_delete_first():
    existing_rows = [
        {
            "person_id": index,
            "worker_name": f"Monteur {index}",
            "monday_hours": index,
            "monday_surcharge_25_hours": index * 2,
        }
        for index in range(1, 4)
    ]
    payload_rows = [
        ExtraWorkWorkerHours(worker_name="Monteur 2", monday_hours=8),
        ExtraWorkWorkerHours(worker_name="Monteur 3", monday_hours=9),
    ]

    merged = ExtraWorkService._merge_mobile_worker_rows(existing_rows, payload_rows)

    assert len(merged) == 2
    assert [row["worker_name"] for row in merged] == ["Monteur 2", "Monteur 3"]
    assert [row["person_id"] for row in merged] == [2, 3]
    assert [row["monday_surcharge_25_hours"] for row in merged] == [4, 6]


def test_legacy_mobile_worker_merge_uses_person_id_across_reorder_and_rename():
    existing_rows = [
        {
            "person_id": 1,
            "worker_name": "Monteur Eins",
            "monday_surcharge_50_hours": 1.5,
        },
        {
            "person_id": 2,
            "worker_name": "Monteur Zwei",
            "monday_surcharge_50_hours": 2.5,
        },
    ]
    payload_rows = [
        ExtraWorkWorkerHours(person_id=2, worker_name="Zwei Neu", monday_hours=4),
        ExtraWorkWorkerHours(person_id=1, worker_name="Eins Neu", monday_hours=3),
    ]

    merged = ExtraWorkService._merge_mobile_worker_rows(existing_rows, payload_rows)

    assert [row["person_id"] for row in merged] == [2, 1]
    assert [row["monday_surcharge_50_hours"] for row in merged] == [2.5, 1.5]


def test_legacy_mobile_worker_merge_does_not_restore_deleted_trailing_rows():
    existing_rows = [
        {"worker_name": f"Monteur {index}", "monday_hours": index}
        for index in range(1, 5)
    ]
    payload_rows = [
        ExtraWorkWorkerHours(worker_name=f"Monteur {index}", monday_hours=index + 1)
        for index in range(1, 4)
    ]

    merged = ExtraWorkService._merge_mobile_worker_rows(existing_rows, payload_rows)

    assert len(merged) == 3
    assert [row["worker_name"] for row in merged] == [
        "Monteur 1",
        "Monteur 2",
        "Monteur 3",
    ]
