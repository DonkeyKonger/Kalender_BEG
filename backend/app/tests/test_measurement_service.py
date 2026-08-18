from datetime import date, datetime, timezone
from decimal import Decimal

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from app.models import Base
from app.models.audit_log import AuditLog
from app.models.enums import (
    MeasurementBatchOrigin,
    MeasurementPositionMode,
    PersonEmploymentStatus,
    PersonType,
    SiteLocationStatus,
    SiteStatus,
    UserRole,
)
from app.models.person import Person
from app.models.site import Site
from app.models.site_measurement_item import (
    SiteMeasurementBase,
    SiteMeasurementBatch,
    SiteMeasurementBatchPhoto,
    SiteMeasurementEntry,
    SiteMeasurementItem,
)
from app.models.user import User
from app.schemas.measurement import (
    MeasurementEntryCreate,
    MobileMeasurementFreeItemCreate,
    OfficeMeasurementBatchCreate,
)
from app.services.measurement_service import MeasurementService, _measurement_archive_filename
from app.services.measurement_timesheet_parser import (
    ParsedMeasurementItem,
    MeasurementTimesheetParseResult,
)


def db_session() -> Session:
    engine = create_engine("sqlite+pysqlite:///:memory:")
    Base.metadata.create_all(engine)
    return Session(engine)


def create_site(db: Session) -> Site:
    site = Site(
        name="Testbaustelle",
        status=SiteStatus.ACTIVE,
        location_status=SiteLocationStatus.UNCHECKED,
    )
    db.add(site)
    db.flush()
    return site


def create_measurement_base(db: Session, site: Site) -> SiteMeasurementBase:
    base = SiteMeasurementBase(
        site=site,
        name="Aufmaßbasis Bestand",
        base_type="mixed",
        status="active",
        released_to_mobile=True,
    )
    db.add(base)
    db.flush()
    return base


def test_measurement_payloads_accept_signed_quantities():
    entry = MeasurementEntryCreate(
        area_or_comment="Korrektur EG",
        quantity=Decimal("-8.50"),
    )
    free_item = MobileMeasurementFreeItemCreate(
        description="Korrekturposition",
        unit="m",
        quantity=Decimal("-3.25"),
    )

    assert entry.quantity == Decimal("-8.50")
    assert free_item.quantity == Decimal("-3.25")


def test_manual_measurement_status_promotion_only_moves_up_and_never_fakes_signature(monkeypatch):
    db = db_session()
    site = create_site(db)
    actor = User(
        username="status-office",
        display_name="Status Büro",
        password_hash="x",
        role=UserRole.OFFICE,
        office_page_permissions=["sites"],
    )
    batch = SiteMeasurementBatch(
        site=site,
        number=1,
        title="Aufmaß 1",
        status="draft",
        origin=MeasurementBatchOrigin.OFFICE.value,
        position_mode=MeasurementPositionMode.BLANK.value,
    )
    item = SiteMeasurementItem(
        site=site,
        measurement_batch=batch,
        position="1.1",
        description="Freie Leistung",
        unit="Stck",
        is_free_position=True,
        sort_order=1,
    )
    entry = SiteMeasurementEntry(
        measurement_batch=batch,
        measurement_item=item,
        site=site,
        quantity=Decimal("1"),
        area_or_comment="EG",
        status="draft",
    )
    db.add_all([actor, batch, item, entry])
    db.commit()
    service = MeasurementService(db)
    archived: list[int] = []
    monkeypatch.setattr(
        service,
        "_archive_billed_batch_pdf",
        lambda *, batch, current_user: archived.append(batch.id),
    )

    reviewed = service.promote_site_batch_status(
        site_id=site.id,
        batch_id=batch.id,
        target_status="reviewed",
        current_user=actor,
    )
    assert reviewed.status == "reviewed"
    assert db.get(SiteMeasurementEntry, entry.id).status == "reviewed"

    with pytest.raises(HTTPException) as downgrade:
        service.promote_site_batch_status(
            site_id=site.id,
            batch_id=batch.id,
            target_status="submitted",
            current_user=actor,
        )
    assert downgrade.value.status_code == 409

    with pytest.raises(HTTPException) as signed:
        service.promote_site_batch_status(
            site_id=site.id,
            batch_id=batch.id,
            target_status="customer_signed",
            current_user=actor,
        )
    assert signed.value.status_code == 400

    unsigned_batch = SiteMeasurementBatch(
        site=site,
        number=2,
        title="Aufmaß 2",
        status="draft",
        origin=MeasurementBatchOrigin.OFFICE.value,
        position_mode=MeasurementPositionMode.BLANK.value,
    )
    db.add(unsigned_batch)
    db.commit()
    unsigned_completed = service.promote_site_batch_status(
        site_id=site.id,
        batch_id=unsigned_batch.id,
        target_status="billed",
        current_user=actor,
    )
    assert unsigned_completed.customer_signed_at is None
    assert unsigned_completed.customer_signature_name is None

    stored_batch = db.get(SiteMeasurementBatch, batch.id)
    stored_batch.status = "customer_signed"
    stored_batch.customer_signature_name = "Kunde Beispiel"
    stored_batch.customer_signed_at = datetime.now(timezone.utc)
    db.commit()

    completed = service.promote_site_batch_status(
        site_id=site.id,
        batch_id=batch.id,
        target_status="billed",
        current_user=actor,
    )
    assert completed.status == "billed"
    assert completed.customer_signed_at is not None
    assert completed.customer_signature_name == "Kunde Beispiel"
    assert archived == [unsigned_batch.id, batch.id]
    logs = list(
        db.scalars(
            select(AuditLog)
            .where(AuditLog.action == "measurement.status_promoted")
            .order_by(AuditLog.id)
        )
    )
    assert [(log.old_value_json, log.new_value_json) for log in logs] == [
        ({"status": "draft"}, {"status": "reviewed"}),
        ({"status": "draft"}, {"status": "billed"}),
        ({"status": "customer_signed"}, {"status": "billed"}),
    ]


def parsed_timesheet() -> MeasurementTimesheetParseResult:
    return MeasurementTimesheetParseResult(
        source_project_number="8007 / P250092",
        source_invoice_number="1260197",
        source_customer_name="ebm elektro-bau-montage GmbH",
        items=[
            ParsedMeasurementItem(
                position="1.01.05.160",
                description="90°Rinnenbogen 500/60 mm FT liefern und montieren",
                list_quantity=Decimal("0.00"),
                unit="Stck",
                minutes_per_unit=Decimal("17.10"),
                list_minutes_total=None,
                is_nep=True,
                sort_order=1,
            )
        ],
    )


def parsed_timesheet_position(
    *,
    invoice_number: str,
    position: str,
    description: str,
) -> MeasurementTimesheetParseResult:
    return MeasurementTimesheetParseResult(
        source_project_number="8007 / P250092",
        source_invoice_number=invoice_number,
        source_customer_name="ebm elektro-bau-montage GmbH",
        items=[
            ParsedMeasurementItem(
                position=position,
                description=description,
                list_quantity=Decimal("10.00"),
                unit="Stck",
                minutes_per_unit=Decimal("10.00"),
                list_minutes_total=Decimal("100.00"),
                is_nep=False,
                sort_order=1,
            )
        ],
    )


def parsed_timesheet_positions(
    *,
    invoice_number: str,
    positions: list[str],
    description_prefix: str,
) -> MeasurementTimesheetParseResult:
    return MeasurementTimesheetParseResult(
        source_project_number="8007 / P250092",
        source_invoice_number=invoice_number,
        source_customer_name="ebm elektro-bau-montage GmbH",
        items=[
            ParsedMeasurementItem(
                position=position,
                description=f"{description_prefix} {position}",
                list_quantity=Decimal("10.00"),
                unit="Stck",
                minutes_per_unit=Decimal("10.00"),
                list_minutes_total=Decimal("100.00"),
                is_nep=False,
                sort_order=index,
            )
            for index, position in enumerate(positions, start=1)
        ],
    )


def test_measurement_archive_filename_uses_completion_date_site_name_and_number():
    site = Site(
        name="Schüchtermann Klinik",
        site_number="8007",
        status=SiteStatus.ACTIVE,
        location_status=SiteLocationStatus.UNCHECKED,
    )
    batch = SiteMeasurementBatch(site=site, number=18)

    filename = _measurement_archive_filename(
        batch,
        completed_at=datetime(2026, 6, 11, 10, 30, tzinfo=timezone.utc),
    )

    assert filename == "260611_Aufmaß_Schüchtermann_Klinik_8007.pdf"


def test_measurement_archive_filename_sanitizes_forbidden_file_characters():
    site = Site(
        name=' Projekt / Nord: A * B ? "Test" ',
        site_number=" 80/07 ",
        status=SiteStatus.ACTIVE,
        location_status=SiteLocationStatus.UNCHECKED,
    )
    batch = SiteMeasurementBatch(site=site, number=18)

    filename = _measurement_archive_filename(
        batch,
        completed_at=datetime(2026, 6, 11, 10, 30, tzinfo=timezone.utc),
    )

    assert filename == "260611_Aufmaß_Projekt_Nord_A_B_Test_80_07.pdf"


def test_import_timesheet_stores_zero_quantity_and_blocks_same_invoice(monkeypatch):
    db = db_session()
    site = create_site(db)
    create_measurement_base(db, site)
    monkeypatch.setattr(
        "app.services.measurement_service.parse_measurement_timesheet_pdf",
        lambda _content: parsed_timesheet(),
    )

    summary, items = MeasurementService(db).import_timesheet(
        site.id, file_name="Zeitvorgabe.pdf", pdf_content=b"pdf"
    )

    stored = db.scalar(select(SiteMeasurementItem).where(SiteMeasurementItem.site_id == site.id))
    assert summary["imported_count"] == 1
    assert len(items) == 1
    assert stored is not None
    assert stored.list_quantity == Decimal("0.00")
    assert stored.is_nep is True
    assert stored.list_minutes_total is None

    with pytest.raises(HTTPException) as error:
        MeasurementService(db).import_timesheet(site.id, file_name="Zeitvorgabe.pdf", pdf_content=b"pdf")

    assert error.value.status_code == 409


def test_import_timesheet_allows_same_position_in_new_measurement_base(monkeypatch):
    db = db_session()
    site = create_site(db)
    base = create_measurement_base(db, site)
    monkeypatch.setattr(
        "app.services.measurement_service.parse_measurement_timesheet_pdf",
        lambda _content: parsed_timesheet(),
    )

    MeasurementService(db).import_timesheet(
        site.id,
        file_name="Hauptangebot 1.pdf",
        pdf_content=b"pdf",
        import_mode="existing",
        measurement_base_id=base.id,
    )

    with pytest.raises(HTTPException) as same_base_error:
        MeasurementService(db).import_timesheet(
            site.id,
            file_name="Nachtrag doppelt.pdf",
            pdf_content=b"pdf",
            import_mode="existing",
            measurement_base_id=base.id,
        )

    summary, items = MeasurementService(db).import_timesheet(
        site.id,
        file_name="Hauptangebot 2.pdf",
        pdf_content=b"pdf",
        import_mode="new",
        measurement_base_name="Hauptangebot 2",
    )

    all_items = list(db.scalars(select(SiteMeasurementItem).where(SiteMeasurementItem.site_id == site.id)).all())
    assert same_base_error.value.status_code == 409
    assert summary["measurement_base"].name == "Hauptangebot 2"
    assert len(items) == 1
    assert len(all_items) == 2
    assert all_items[0].position == all_items[1].position
    assert all_items[0].measurement_base_id != all_items[1].measurement_base_id


def test_appended_offer_extends_position_catalog_for_existing_and_new_batches(monkeypatch):
    from app.models.assignment import Assignment
    from app.models.enums import AssignmentType

    db = db_session()
    site = create_site(db)
    base = create_measurement_base(db, site)
    main_positions = [f"444.4.{index:03d}" for index in range(10, 210, 10)]
    supplement_positions = [f"N1.{index}" for index in range(10, 60, 10)]
    parsed_by_content = {
        b"main": parsed_timesheet_positions(
            invoice_number="MAIN-001",
            positions=main_positions,
            description_prefix="Position aus Hauptangebot",
        ),
        b"supplement": parsed_timesheet_positions(
            invoice_number="N1-001",
            positions=supplement_positions,
            description_prefix="Position aus Nachtragsangebot",
        ),
    }
    monkeypatch.setattr(
        "app.services.measurement_service.parse_measurement_timesheet_pdf",
        lambda content: parsed_by_content[content],
    )

    service = MeasurementService(db)
    _summary, main_items = service.import_timesheet(
        site.id,
        file_name="Hauptangebot.pdf",
        pdf_content=b"main",
        import_mode="append_existing",
        measurement_base_id=base.id,
    )
    person = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
        person_type=PersonType.INTERNAL,
    )
    user = User(
        username="max-catalog",
        display_name="Max Monteur",
        password_hash="x",
        role=UserRole.MONTEUR,
        person=person,
    )
    assignment = Assignment(
        site=site,
        person=person,
        start_date=date(2026, 6, 15),
        end_date=date(2026, 6, 15),
        assignment_type=AssignmentType.REGULAR,
    )
    db.add_all([user, assignment])
    db.commit()

    existing_batch = service.create_mobile_batch(
        assignment_id=assignment.id,
        current_user=user,
    )
    _summary, supplement_items = service.import_timesheet(
        site.id,
        file_name="Nachtragsangebot.pdf",
        pdf_content=b"supplement",
        import_mode="append_existing",
        measurement_base_id=base.id,
    )
    timesheet_ids = [row.position_id for row in service.get_site_measurement_timesheet(site.id).rows]
    new_batch = service.create_mobile_batch(
        assignment_id=assignment.id,
        current_user=user,
    )
    db.expire_all()

    expected_ids = [item.id for item in [*main_items, *supplement_items]]
    existing_desktop_ids = [
        item.id
        for item in service.list_site_batch_items(site_id=site.id, batch_id=existing_batch.id)
    ]
    existing_mobile_ids = [
        item.id
        for item in service.list_mobile_batch_items(
            assignment_id=assignment.id,
            batch_id=existing_batch.id,
            current_user=user,
        )
    ]
    new_mobile_ids = [
        item.id
        for item in service.list_mobile_batch_items(
            assignment_id=assignment.id,
            batch_id=new_batch.id,
            current_user=user,
        )
    ]

    assert len(main_items) == 20
    assert len(supplement_items) == 5
    assert all(item.measurement_base_id == base.id for item in main_items)
    assert all(item.measurement_base_id == base.id for item in supplement_items)
    assert timesheet_ids == expected_ids
    assert existing_desktop_ids == expected_ids
    assert existing_mobile_ids == expected_ids
    assert new_mobile_ids == expected_ids
    assert [item.source_file_name for item in main_items] == ["Hauptangebot.pdf"] * 20
    assert [item.source_file_name for item in supplement_items] == ["Nachtragsangebot.pdf"] * 5
    assert all(item.entries == [] for item in service.list_site_batch_items(
        site_id=site.id,
        batch_id=existing_batch.id,
    ))


def test_historical_batch_uses_released_total_catalog_with_supplement_without_minutes():
    from app.models.assignment import Assignment
    from app.models.enums import AssignmentType
    from app.schemas.measurement import MeasurementEntryCreate, MeasurementItemUpdate

    db = db_session()
    site = create_site(db)
    historical_base = create_measurement_base(db, site)
    historical_base.status = "closed"
    historical_base.released_to_mobile = False
    total_base = SiteMeasurementBase(
        site=site,
        name="Gesamtbasis mit Nachtrag",
        base_type="main_offer",
        status="active",
        released_to_mobile=True,
    )
    inactive_base = SiteMeasurementBase(
        site=site,
        name="Nicht freigegebener Entwurf",
        base_type="main_offer",
        status="draft",
        released_to_mobile=False,
    )
    historical_item = SiteMeasurementItem(
        site=site,
        measurement_base=historical_base,
        position="444.4.310",
        description="Ursprüngliche Position",
        unit="m",
        minutes_per_unit=Decimal("5"),
        sort_order=1,
    )
    copied_item = SiteMeasurementItem(
        site=site,
        measurement_base=total_base,
        position=" 444.4.310 ",
        description="Kopie in der Gesamtbasis",
        unit="m",
        minutes_per_unit=Decimal("5"),
        sort_order=1,
    )
    supplement_item = SiteMeasurementItem(
        site=site,
        measurement_base=total_base,
        position="N1.10",
        description="Nachtrag ohne Kalkulationszeit",
        unit="Stck",
        minutes_per_unit=None,
        list_minutes_total=None,
        sort_order=10,
    )
    inactive_item = SiteMeasurementItem(
        site=site,
        measurement_base=inactive_base,
        position="N9.99",
        description="Nicht freigegebene Position",
        unit="Stck",
        sort_order=99,
    )
    person = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
        person_type=PersonType.INTERNAL,
    )
    user = User(
        username="historical-catalog-worker",
        display_name="Max Monteur",
        password_hash="x",
        role=UserRole.MONTEUR,
        person=person,
    )
    assignment = Assignment(
        site=site,
        person=person,
        start_date=date(2026, 8, 14),
        end_date=date(2026, 8, 14),
        assignment_type=AssignmentType.REGULAR,
    )
    desktop_batch = SiteMeasurementBatch(
        site=site,
        measurement_base=historical_base,
        number=1,
        title="Historisches Aufmaß Büro",
        status="submitted",
        origin=MeasurementBatchOrigin.MONTEUR.value,
        position_mode=MeasurementPositionMode.OFFER_BASED.value,
    )
    mobile_batch = SiteMeasurementBatch(
        site=site,
        measurement_base=historical_base,
        number=2,
        title="Historisches Aufmaß mobil",
        status="draft",
        origin=MeasurementBatchOrigin.MONTEUR.value,
        position_mode=MeasurementPositionMode.OFFER_BASED.value,
    )
    historical_entry = SiteMeasurementEntry(
        measurement_batch=desktop_batch,
        measurement_item=historical_item,
        site=site,
        quantity=Decimal("8.4"),
        area_or_comment="EG",
        status="submitted",
    )
    free_item = SiteMeasurementItem(
        site=site,
        measurement_base=historical_base,
        measurement_batch=desktop_batch,
        position="N1.10",
        description="Frei erfasste Nachtragsposition",
        unit="Stck",
        is_free_position=True,
        sort_order=20,
    )
    free_entry = SiteMeasurementEntry(
        measurement_batch=desktop_batch,
        measurement_item=free_item,
        site=site,
        quantity=Decimal("4"),
        area_or_comment="1. OG",
        status="submitted",
    )
    db.add_all(
        [
            total_base,
            inactive_base,
            historical_item,
            copied_item,
            supplement_item,
            inactive_item,
            user,
            assignment,
            desktop_batch,
            mobile_batch,
            historical_entry,
            free_item,
            free_entry,
        ]
    )
    db.commit()
    service = MeasurementService(db)

    desktop_items = service.list_site_batch_items(
        site_id=site.id,
        batch_id=desktop_batch.id,
    )
    desktop_ids = {item.id for item in desktop_items}
    assert historical_item.id in desktop_ids
    assert copied_item.id not in desktop_ids
    assert supplement_item.id in desktop_ids
    assert inactive_item.id not in desktop_ids
    assert [item.id for item in desktop_items if item.entries] == [historical_item.id, free_item.id]

    mobile_ids = {
        item.id
        for item in service.list_mobile_batch_items(
            assignment_id=assignment.id,
            batch_id=mobile_batch.id,
            current_user=user,
        )
    }
    assert historical_item.id in mobile_ids
    assert copied_item.id not in mobile_ids
    assert supplement_item.id in mobile_ids
    assert inactive_item.id not in mobile_ids

    linked = service.update_site_free_item(
        site_id=site.id,
        batch_id=desktop_batch.id,
        measurement_item_id=free_item.id,
        payload=MeasurementItemUpdate(linked_measurement_item_id=supplement_item.id),
    )
    assert linked.linked_measurement_item_id == supplement_item.id
    assert linked.reported_quantity == Decimal("4")

    mobile_entry = service.create_mobile_entry(
        assignment_id=assignment.id,
        batch_id=mobile_batch.id,
        measurement_item_id=supplement_item.id,
        current_user=user,
        payload=MeasurementEntryCreate(area_or_comment="EG", quantity=Decimal("1")),
    )
    assert mobile_entry.quantity == Decimal("1")

    service.activate_measurement_base(site_id=site.id, measurement_base_id=inactive_base.id)
    with pytest.raises(HTTPException) as delete_error:
        service.delete_measurement_base(site_id=site.id, measurement_base_id=total_base.id)
    assert delete_error.value.status_code == 409


def test_mobile_free_measurement_item_is_stored_on_batch_base():
    from app.models.assignment import Assignment
    from app.models.enums import AssignmentType, PersonType, UserRole
    from app.models.person import Person
    from app.models.site_measurement_item import SiteMeasurementEntry
    from app.models.user import User
    from app.schemas.measurement import MobileMeasurementFreeItemCreate

    db = db_session()
    site = create_site(db)
    base = create_measurement_base(db, site)
    person = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
        person_type=PersonType.INTERNAL,
    )
    user = User(
        username="max",
        display_name="Max Monteur",
        password_hash="x",
        role=UserRole.MONTEUR,
        person=person,
    )
    assignment = Assignment(
        site=site,
        person=person,
        start_date=date(2026, 6, 15),
        end_date=date(2026, 6, 15),
        assignment_type=AssignmentType.REGULAR,
    )
    existing_item = SiteMeasurementItem(
        site=site,
        measurement_base=base,
        position="1.01.05.10",
        description="Kabelrinne liefern und montieren",
        list_quantity=Decimal("0.00"),
        unit="m",
        minutes_per_unit=Decimal("19.80"),
        list_minutes_total=Decimal("0.00"),
        is_nep=False,
        sort_order=1,
    )
    db.add_all([user, assignment, existing_item])
    db.commit()

    service = MeasurementService(db)
    batch = service.create_mobile_batch(assignment_id=assignment.id, current_user=user)
    item = service.create_mobile_free_item(
        assignment_id=assignment.id,
        batch_id=batch.id,
        current_user=user,
        payload=MobileMeasurementFreeItemCreate(
            description="Zusätzliche Kabelbefestigung",
            unit="Stck",
            quantity=Decimal("-2.00"),
            area_or_comment="2. OG",
        ),
    )

    stored_item = db.get(SiteMeasurementItem, item.id)
    stored_entry = db.scalar(
        select(SiteMeasurementEntry).where(SiteMeasurementEntry.measurement_item_id == item.id)
    )
    assert stored_item is not None
    assert stored_item.measurement_base_id == base.id
    assert stored_item.position == "FREI-1"
    assert stored_item.is_free_position is True
    assert stored_item.source_file_name is None
    assert item.is_free_position is True
    assert item.reported_quantity == Decimal("-2.00")
    assert stored_entry is not None
    assert stored_entry.measurement_batch_id == batch.id
    assert stored_entry.area_or_comment == "2. OG"
    assert stored_entry.quantity == Decimal("-2.00")


def test_new_measurement_base_import_becomes_only_active_base(monkeypatch):
    db = db_session()
    site = create_site(db)
    old_base = create_measurement_base(db, site)
    monkeypatch.setattr(
        "app.services.measurement_service.parse_measurement_timesheet_pdf",
        lambda _content: parsed_timesheet(),
    )

    summary, _items = MeasurementService(db).import_timesheet(
        site.id,
        file_name="Hauptangebot 2.pdf",
        pdf_content=b"pdf",
        import_mode="create_new",
        measurement_base_name="Aufmaßblatt 2",
    )

    db.refresh(old_base)
    new_base = db.get(SiteMeasurementBase, summary["measurement_base"].id)
    assert new_base is not None
    assert new_base.status == "active"
    assert new_base.released_to_mobile is True
    assert old_base.status == "draft"
    assert old_base.released_to_mobile is False


def test_site_measurement_lists_can_be_scoped_to_active_offer():
    from app.models.site_measurement_item import SiteMeasurementBatch, SiteMeasurementItem

    db = db_session()
    site = create_site(db)
    old_base = create_measurement_base(db, site)
    old_base.status = "draft"
    old_base.released_to_mobile = False
    active_base = SiteMeasurementBase(
        site=site,
        name="Aktuelles Angebot",
        base_type="main_offer",
        status="active",
        released_to_mobile=True,
    )
    old_item = SiteMeasurementItem(
        site=site,
        measurement_base=old_base,
        position="1.01.05.10",
        description="Alte Position",
        list_quantity=Decimal("10.00"),
        unit="m",
        minutes_per_unit=Decimal("10.00"),
        list_minutes_total=Decimal("100.00"),
        is_nep=False,
        sort_order=1,
    )
    active_item = SiteMeasurementItem(
        site=site,
        measurement_base=active_base,
        position="1.01.05.10",
        description="Aktuelle Position",
        list_quantity=Decimal("5.00"),
        unit="m",
        minutes_per_unit=Decimal("10.00"),
        list_minutes_total=Decimal("50.00"),
        is_nep=False,
        sort_order=1,
    )
    old_batch = SiteMeasurementBatch(
        site=site,
        measurement_base=old_base,
        number=1,
        title="Aufmaß 1",
        status="billed",
    )
    active_batch = SiteMeasurementBatch(
        site=site,
        measurement_base=active_base,
        number=2,
        title="Aufmaß 2",
        status="submitted",
    )
    db.add_all([active_base, old_item, active_item, old_batch, active_batch])
    db.commit()

    service = MeasurementService(db)
    active_items = service.list_items(site.id, active_only=True)
    all_batches = service.list_site_batches(site.id)
    active_batches = service.list_site_batches(site.id, active_only=True)

    assert [item.id for item in active_items] == [active_item.id]
    assert [batch.id for batch in active_batches] == [active_batch.id]
    assert {batch.id: batch.is_current_offer for batch in all_batches} == {
        old_batch.id: False,
        active_batch.id: True,
    }
    assert all_batches[0].offer_id == old_base.id
    assert all_batches[0].offer_name == old_base.name
    assert all_batches[1].offer_id == active_base.id
    assert all_batches[1].offer_name == active_base.name


def test_measurement_item_hide_excludes_active_views_but_keeps_entries():
    db = db_session()
    site = create_site(db)
    base = create_measurement_base(db, site)
    visible_item = SiteMeasurementItem(
        site=site,
        measurement_base=base,
        position="1.01.01",
        description="Sichtbare Position",
        list_quantity=Decimal("5.00"),
        unit="m",
        minutes_per_unit=Decimal("10.00"),
        list_minutes_total=Decimal("50.00"),
        is_nep=False,
        sort_order=1,
    )
    hidden_item = SiteMeasurementItem(
        site=site,
        measurement_base=base,
        position="1.01.02",
        description="Ausgeblendete Position",
        list_quantity=Decimal("7.00"),
        unit="m",
        minutes_per_unit=Decimal("10.00"),
        list_minutes_total=Decimal("70.00"),
        is_nep=False,
        sort_order=2,
    )
    batch = SiteMeasurementBatch(
        site=site,
        measurement_base=base,
        number=1,
        title="Aufmaß 1",
        status="submitted",
    )
    db.add_all([visible_item, hidden_item, batch])
    db.flush()
    hidden_entry = SiteMeasurementEntry(
        measurement_batch_id=batch.id,
        measurement_item_id=hidden_item.id,
        site_id=site.id,
        quantity=Decimal("2.00"),
        area_or_comment="1. OG",
        status="saved",
    )
    visible_entry = SiteMeasurementEntry(
        measurement_batch_id=batch.id,
        measurement_item_id=visible_item.id,
        site_id=site.id,
        quantity=Decimal("1.00"),
        area_or_comment="EG",
        status="saved",
    )
    db.add_all([hidden_entry, visible_entry])
    db.commit()

    service = MeasurementService(db)
    service.hide_item(site_id=site.id, measurement_item_id=hidden_item.id)

    listed_items = service.list_items(site.id)
    timesheet = service.get_site_measurement_timesheet(site.id)
    mobile_items = service.list_site_batch_items(site_id=site.id, batch_id=batch.id)
    stored_hidden_entry = db.get(SiteMeasurementEntry, hidden_entry.id)

    assert [item.id for item in listed_items] == [visible_item.id]
    assert [row.position_id for row in timesheet.rows] == [visible_item.id]
    assert [item.id for item in mobile_items] == [visible_item.id]
    assert stored_hidden_entry is not None
    assert stored_hidden_entry.measurement_item_id == hidden_item.id


def test_measurement_base_activate_and_delete_rules():
    db = db_session()
    site = create_site(db)
    old_base = create_measurement_base(db, site)
    new_base = SiteMeasurementBase(
        site=site,
        name="Aufmaßblatt 2",
        base_type="main_offer",
        status="draft",
        released_to_mobile=False,
    )
    delete_base = SiteMeasurementBase(
        site=site,
        name="Leeres Aufmaßblatt",
        base_type="main_offer",
        status="draft",
        released_to_mobile=False,
    )
    db.add_all([new_base, delete_base])
    db.commit()

    service = MeasurementService(db)
    bases = service.activate_measurement_base(site_id=site.id, measurement_base_id=new_base.id)
    db.refresh(old_base)
    db.refresh(new_base)

    with pytest.raises(HTTPException) as active_delete_error:
        service.delete_measurement_base(site_id=site.id, measurement_base_id=new_base.id)
    deleted_bases = service.delete_measurement_base(site_id=site.id, measurement_base_id=delete_base.id)

    assert sum(1 for base in bases if base.status == "active" and base.released_to_mobile) == 1
    assert old_base.status == "draft"
    assert old_base.released_to_mobile is False
    assert new_base.status == "active"
    assert new_base.released_to_mobile is True
    assert active_delete_error.value.status_code == 409
    assert all(base.id != delete_base.id for base in deleted_bases)


def test_mobile_batch_uses_only_active_released_measurement_base():
    from datetime import date

    from app.models.assignment import Assignment
    from app.models.enums import AssignmentType, PersonType, UserRole
    from app.models.person import Person
    from app.models.user import User

    db = db_session()
    site = create_site(db)
    old_base = create_measurement_base(db, site)
    old_base.status = "closed"
    old_base.released_to_mobile = False
    new_base = SiteMeasurementBase(
        site=site,
        name="Hauptangebot 2",
        base_type="main_offer",
        status="active",
        released_to_mobile=True,
    )
    old_item = SiteMeasurementItem(
        site=site,
        measurement_base=old_base,
        position="1.01.05.10",
        description="Alte Position",
        list_quantity=Decimal("0.00"),
        unit="m",
        minutes_per_unit=Decimal("10.00"),
        list_minutes_total=Decimal("0.00"),
        is_nep=False,
        sort_order=1,
    )
    new_item = SiteMeasurementItem(
        site=site,
        measurement_base=new_base,
        position="1.01.05.10",
        description="Neue Position",
        list_quantity=Decimal("0.00"),
        unit="m",
        minutes_per_unit=Decimal("10.00"),
        list_minutes_total=Decimal("0.00"),
        is_nep=False,
        sort_order=1,
    )
    person = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
        person_type=PersonType.INTERNAL,
    )
    user = User(
        username="max",
        display_name="Max Monteur",
        password_hash="x",
        role=UserRole.MONTEUR,
        person=person,
    )
    assignment = Assignment(
        site=site,
        person=person,
        start_date=date(2026, 5, 26),
        end_date=date(2026, 5, 26),
        assignment_type=AssignmentType.REGULAR,
    )
    db.add_all([new_base, old_item, new_item, user, assignment])
    db.commit()

    service = MeasurementService(db)
    batch = service.create_mobile_batch(assignment_id=assignment.id, current_user=user)
    mobile_items = service.list_mobile_batch_items(
        assignment_id=assignment.id,
        batch_id=batch.id,
        current_user=user,
    )

    assert batch.measurement_base_id == new_base.id
    assert [item.id for item in mobile_items] == [new_item.id]
    assert mobile_items[0].description == "Neue Position"


def test_mobile_measurement_photo_upload_blocks_after_five_photos():
    from datetime import date

    from app.models.assignment import Assignment
    from app.models.enums import AssignmentType, PersonType, UserRole
    from app.models.person import Person
    from app.models.user import User

    db = db_session()
    site = create_site(db)
    base = create_measurement_base(db, site)
    item = SiteMeasurementItem(
        site=site,
        measurement_base=base,
        position="1.01.05.10",
        description="Kabelrinne liefern und montieren",
        list_quantity=Decimal("0.00"),
        unit="m",
        minutes_per_unit=Decimal("19.80"),
        list_minutes_total=Decimal("0.00"),
        is_nep=False,
        sort_order=1,
    )
    person = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
        person_type=PersonType.INTERNAL,
    )
    user = User(
        username="max",
        display_name="Max Monteur",
        password_hash="x",
        role=UserRole.MONTEUR,
        person=person,
    )
    assignment = Assignment(
        site=site,
        person=person,
        start_date=date(2026, 5, 26),
        end_date=date(2026, 5, 26),
        assignment_type=AssignmentType.REGULAR,
    )
    db.add_all([item, user, assignment])
    db.commit()

    service = MeasurementService(db)
    batch = service.create_mobile_batch(assignment_id=assignment.id, current_user=user)
    for index in range(5):
        db.add(
            SiteMeasurementBatchPhoto(
                site_id=site.id,
                measurement_batch_id=batch.id,
                uploaded_by_user_id=user.id,
                project_folder_key="fotos",
                external_drive_id="drive-1",
                external_item_id=f"photo-{index}",
                filename=f"photo-{index}.jpg",
                content_type="image/jpeg",
                file_size_bytes=100,
            )
        )
    db.commit()

    with pytest.raises(HTTPException) as error:
        service.upload_mobile_batch_photo(
            assignment_id=assignment.id,
            batch_id=batch.id,
            current_user=user,
            filename="extra.jpg",
            content=b"image-content",
            content_type="image/jpeg",
        )

    assert error.value.status_code == 400
    assert error.value.detail == "Maximal 5 Fotos erlaubt."


def test_mobile_measurement_entry_keeps_imported_item_and_summarizes_quantity():
    from datetime import date

    from app.models.assignment import Assignment
    from app.models.enums import AssignmentType, PersonType, UserRole
    from app.models.person import Person
    from app.models.site_measurement_item import SiteMeasurementBatch, SiteMeasurementEntry
    from app.models.user import User
    db = db_session()
    site = create_site(db)
    base = create_measurement_base(db, site)
    person = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
        person_type=PersonType.INTERNAL,
    )
    user = User(
        username="max",
        display_name="Max Monteur",
        password_hash="x",
        role=UserRole.MONTEUR,
        person=person,
    )
    assignment = Assignment(
        site=site,
        person=person,
        start_date=date(2026, 5, 26),
        end_date=date(2026, 5, 26),
        assignment_type=AssignmentType.REGULAR,
    )
    item = SiteMeasurementItem(
        site=site,
        measurement_base=base,
        position="1.01.05.10",
        description="Kabelrinne liefern und montieren",
        list_quantity=Decimal("0.00"),
        unit="m",
        minutes_per_unit=Decimal("19.80"),
        list_minutes_total=Decimal("0.00"),
        is_nep=False,
        sort_order=1,
    )
    db.add_all([user, assignment, item])
    db.commit()

    service = MeasurementService(db)
    batch = service.create_mobile_batch(assignment_id=assignment.id, current_user=user)
    entry = service.create_mobile_entry(
        assignment_id=assignment.id,
        batch_id=batch.id,
        measurement_item_id=item.id,
        current_user=user,
        payload=MeasurementEntryCreate(area_or_comment="1. OG Flur", quantity=Decimal("10.00")),
    )
    correction_entry = service.create_mobile_entry(
        assignment_id=assignment.id,
        batch_id=batch.id,
        measurement_item_id=item.id,
        current_user=user,
        payload=MeasurementEntryCreate(
            area_or_comment="Korrektur 1. OG",
            quantity=Decimal("-12.50"),
        ),
    )
    mobile_items = service.list_mobile_batch_items(
        assignment_id=assignment.id,
        batch_id=batch.id,
        current_user=user,
    )
    mobile_batches = service.list_mobile_batches(assignment_id=assignment.id, current_user=user)

    stored_item = db.get(SiteMeasurementItem, item.id)
    stored_batch = db.get(SiteMeasurementBatch, batch.id)
    stored_entry = db.get(SiteMeasurementEntry, entry.id)
    stored_correction_entry = db.get(SiteMeasurementEntry, correction_entry.id)
    assert stored_item is not None
    assert stored_item.list_quantity == Decimal("0.00")
    assert stored_batch is not None
    assert stored_batch.title == "Aufmaß 1"
    assert stored_batch.status == "draft"
    assert stored_entry is not None
    assert stored_entry.measurement_batch_id == batch.id
    assert stored_entry.area_or_comment == "1. OG Flur"
    assert stored_correction_entry is not None
    assert stored_correction_entry.quantity == Decimal("-12.50")
    assert mobile_items[0].reported_quantity == Decimal("-2.50")
    assert mobile_items[0].reported_minutes == Decimal("-49.5000")
    assert mobile_items[0].mobile_status == "edited"
    assert mobile_batches[0].entry_count == 2
    assert mobile_batches[0].position_count == 1
    assert mobile_batches[0].reported_minutes == Decimal("-49.5000")

    submitted = service.submit_mobile_batch(
        assignment_id=assignment.id,
        batch_id=batch.id,
        current_user=user,
    )
    assert submitted.status == "submitted"
    assert db.get(SiteMeasurementEntry, correction_entry.id).quantity == Decimal("-12.50")


def test_mobile_measurement_batch_submit_requires_entries_and_locks_batch():
    from datetime import date

    from app.models.assignment import Assignment
    from app.models.enums import AssignmentType, PersonType, UserRole
    from app.models.person import Person
    from app.models.user import User
    from app.schemas.measurement import MeasurementEntryCreate

    db = db_session()
    site = create_site(db)
    base = create_measurement_base(db, site)
    person = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
        person_type=PersonType.INTERNAL,
    )
    user = User(
        username="max",
        display_name="Max Monteur",
        password_hash="x",
        role=UserRole.MONTEUR,
        person=person,
    )
    assignment = Assignment(
        site=site,
        person=person,
        start_date=date(2026, 5, 26),
        end_date=date(2026, 5, 26),
        assignment_type=AssignmentType.REGULAR,
    )
    item = SiteMeasurementItem(
        site=site,
        measurement_base=base,
        position="1.01.05.10",
        description="Kabelrinne liefern und montieren",
        list_quantity=Decimal("0.00"),
        unit="m",
        minutes_per_unit=Decimal("19.80"),
        list_minutes_total=Decimal("0.00"),
        is_nep=False,
        sort_order=1,
    )
    db.add_all([user, assignment, item])
    db.commit()

    service = MeasurementService(db)
    batch = service.create_mobile_batch(assignment_id=assignment.id, current_user=user)

    with pytest.raises(HTTPException) as empty_submit:
        service.submit_mobile_batch(assignment_id=assignment.id, batch_id=batch.id, current_user=user)
    assert empty_submit.value.status_code == 400

    service.create_mobile_entry(
        assignment_id=assignment.id,
        batch_id=batch.id,
        measurement_item_id=item.id,
        current_user=user,
        payload=MeasurementEntryCreate(area_or_comment="1. OG Flur", quantity=Decimal("-10.00")),
    )
    submitted = service.submit_mobile_batch(assignment_id=assignment.id, batch_id=batch.id, current_user=user)

    assert submitted.status == "submitted"
    assert submitted.submitted_by_user_id == user.id
    assert submitted.submitted_at is not None

    with pytest.raises(HTTPException) as locked:
        service.create_mobile_entry(
            assignment_id=assignment.id,
            batch_id=batch.id,
            measurement_item_id=item.id,
            current_user=user,
            payload=MeasurementEntryCreate(area_or_comment="2. OG", quantity=Decimal("-5.00")),
        )
    assert locked.value.status_code == 409


def test_mobile_measurement_reentry_replaces_previous_area_quantity():
    from datetime import date

    from app.models.assignment import Assignment
    from app.models.enums import AssignmentType, PersonType, UserRole
    from app.models.person import Person
    from app.models.site_measurement_item import SiteMeasurementBatch, SiteMeasurementEntry
    from app.models.user import User
    from app.schemas.measurement import MeasurementEntryCreate
    from app.services.measurement_pdf_service import MeasurementPdfService

    db = db_session()
    site = create_site(db)
    base = create_measurement_base(db, site)
    person = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
        person_type=PersonType.INTERNAL,
    )
    user = User(
        username="max-reentry",
        display_name="Max Monteur",
        password_hash="x",
        role=UserRole.MONTEUR,
        person=person,
    )
    assignment = Assignment(
        site=site,
        person=person,
        start_date=date(2026, 5, 26),
        end_date=date(2026, 5, 26),
        assignment_type=AssignmentType.REGULAR,
    )
    item = SiteMeasurementItem(
        site=site,
        measurement_base=base,
        position="1.01.05.10",
        description="Kabelrinne liefern und montieren",
        list_quantity=Decimal("0.00"),
        unit="m",
        minutes_per_unit=Decimal("19.80"),
        list_minutes_total=Decimal("0.00"),
        is_nep=False,
        sort_order=1,
    )
    db.add_all([user, assignment, item])
    db.commit()

    service = MeasurementService(db)
    batch = service.create_mobile_batch(assignment_id=assignment.id, current_user=user)
    service.create_mobile_entry(
        assignment_id=assignment.id,
        batch_id=batch.id,
        measurement_item_id=item.id,
        current_user=user,
        payload=MeasurementEntryCreate(area_or_comment="EG", quantity=Decimal("10.00")),
    )
    service.create_mobile_entry(
        assignment_id=assignment.id,
        batch_id=batch.id,
        measurement_item_id=item.id,
        current_user=user,
        payload=MeasurementEntryCreate(area_or_comment=" EG ", quantity=Decimal("5.00")),
    )

    stored_entries = list(
        db.scalars(
            select(SiteMeasurementEntry).where(SiteMeasurementEntry.measurement_batch_id == batch.id)
        ).all()
    )
    mobile_items = service.list_mobile_batch_items(
        assignment_id=assignment.id,
        batch_id=batch.id,
        current_user=user,
    )
    submitted = service.submit_mobile_batch(assignment_id=assignment.id, batch_id=batch.id, current_user=user)
    review_items = service.list_site_batch_items(site_id=site.id, batch_id=submitted.id)
    _positions, _areas, checked_cells, checked_totals = MeasurementPdfService(db)._build_matrix(
        db.get(SiteMeasurementBatch, submitted.id),
        mode="checked",
    )

    assert len(stored_entries) == 1
    assert stored_entries[0].quantity == Decimal("5.00")
    assert mobile_items[0].reported_quantity == Decimal("5.00")
    assert len(review_items[0].entries) == 1
    assert review_items[0].entries[0].quantity == Decimal("5.00")
    assert checked_cells[("eg", item.id)].quantity == Decimal("5.00")
    assert checked_totals[item.id] == Decimal("5.00")
    assert submitted.entry_count == 1


def test_legacy_duplicate_measurement_entries_use_latest_cell_value():
    from app.models.site_measurement_item import SiteMeasurementBatch, SiteMeasurementEntry
    from app.services.measurement_pdf_service import MeasurementPdfService

    db = db_session()
    site = create_site(db)
    base = create_measurement_base(db, site)
    item = SiteMeasurementItem(
        site=site,
        measurement_base=base,
        position="1.01.05.10",
        description="Kabelrinne liefern und montieren",
        list_quantity=Decimal("0.00"),
        unit="m",
        minutes_per_unit=Decimal("19.80"),
        list_minutes_total=Decimal("0.00"),
        is_nep=False,
        sort_order=1,
    )
    batch = SiteMeasurementBatch(
        site=site,
        measurement_base=base,
        number=1,
        title="Aufmaß 1",
        status="billed",
    )
    old_entry = SiteMeasurementEntry(
        measurement_batch=batch,
        measurement_item=item,
        site=site,
        quantity=Decimal("10.00"),
        area_or_comment="EG",
        status="submitted",
    )
    db.add_all([item, batch, old_entry])
    db.commit()
    new_entry = SiteMeasurementEntry(
        measurement_batch=batch,
        measurement_item=item,
        site=site,
        quantity=Decimal("5.00"),
        area_or_comment=" EG ",
        status="submitted",
    )
    db.add(new_entry)
    db.commit()
    db.refresh(batch)

    service = MeasurementService(db)
    review_items = service.list_site_batch_items(site_id=site.id, batch_id=batch.id)
    timesheet = service.get_site_measurement_timesheet(site.id)
    _positions, _areas, checked_cells, checked_totals = MeasurementPdfService(db)._build_matrix(
        db.get(SiteMeasurementBatch, batch.id),
        mode="checked",
    )

    assert len(review_items[0].entries) == 1
    assert review_items[0].entries[0].id == new_entry.id
    assert review_items[0].entries[0].quantity == Decimal("5.00")
    assert timesheet.rows[0].measured_quantity == Decimal("5.00")
    assert checked_cells[("eg", item.id)].quantity == Decimal("5.00")
    assert checked_totals[item.id] == Decimal("5.00")


def test_execution_progress_aggregates_all_completed_origins_by_id_or_position():
    db = db_session()
    site = create_site(db)
    base = create_measurement_base(db, site)
    target_item = SiteMeasurementItem(
        site=site,
        measurement_base=base,
        position="1.1",
        description="Kabelrinne",
        list_quantity=Decimal("124"),
        unit="m",
        minutes_per_unit=Decimal("2"),
        list_minutes_total=Decimal("248"),
        is_nep=False,
        sort_order=1,
    )
    worker_batch = SiteMeasurementBatch(
        site=site,
        measurement_base=base,
        number=1,
        title="Monteur-Aufmaß",
        status="billed",
        origin=MeasurementBatchOrigin.MONTEUR.value,
        position_mode=MeasurementPositionMode.OFFER_BASED.value,
        creator_role_at_creation=UserRole.MONTEUR.value,
    )
    second_worker_batch = SiteMeasurementBatch(
        site=site,
        measurement_base=base,
        number=6,
        title="Zweites Monteur-Aufmaß",
        status="approved",
        origin=MeasurementBatchOrigin.MONTEUR.value,
        position_mode=MeasurementPositionMode.OFFER_BASED.value,
        creator_role_at_creation=UserRole.MONTEUR.value,
    )
    office_batch = SiteMeasurementBatch(
        site=site,
        number=2,
        title="Büro-Aufmaß Bestand",
        status="billed",
        origin=MeasurementBatchOrigin.OFFICE.value,
        position_mode=MeasurementPositionMode.BLANK.value,
        creator_role_at_creation=UserRole.OFFICE.value,
    )
    project_manager_batch = SiteMeasurementBatch(
        site=site,
        number=3,
        title="Projektleiter-Aufmaß",
        status="closed",
        origin=MeasurementBatchOrigin.OFFICE.value,
        position_mode=MeasurementPositionMode.BLANK.value,
        creator_role_at_creation=UserRole.PROJECT_MANAGER.value,
    )
    open_batch = SiteMeasurementBatch(
        site=site,
        number=4,
        title="Noch offen",
        status="submitted",
        origin=MeasurementBatchOrigin.OFFICE.value,
        position_mode=MeasurementPositionMode.BLANK.value,
    )
    deleted_batch = SiteMeasurementBatch(
        site=site,
        number=5,
        title="Archiviert",
        status="billed",
        origin=MeasurementBatchOrigin.OFFICE.value,
        position_mode=MeasurementPositionMode.BLANK.value,
        deleted_at=datetime.now(timezone.utc),
    )
    db.add_all([
        target_item,
        worker_batch,
        second_worker_batch,
        office_batch,
        project_manager_batch,
        open_batch,
        deleted_batch,
    ])
    db.flush()

    def free_item(batch: SiteMeasurementBatch, position: str, sort_order: int) -> SiteMeasurementItem:
        return SiteMeasurementItem(
            site=site,
            measurement_batch=batch,
            position=position,
            description="Freie Leistung",
            unit="m",
            is_free_position=True,
            sort_order=sort_order,
        )

    office_item = free_item(office_batch, " 1.1 ", 10)
    unmatched_item = free_item(office_batch, "99.9", 20)
    project_manager_item = free_item(project_manager_batch, "1.1", 10)
    open_item = free_item(open_batch, "1.1", 10)
    deleted_item = free_item(deleted_batch, "1.1", 10)
    db.add_all([office_item, unmatched_item, project_manager_item, open_item, deleted_item])
    db.flush()
    db.add_all([
        SiteMeasurementEntry(
            measurement_batch=worker_batch,
            measurement_item=target_item,
            site=site,
            quantity=Decimal("4"),
            area_or_comment="EG",
            status="billed",
        ),
        SiteMeasurementEntry(
            measurement_batch=second_worker_batch,
            measurement_item=target_item,
            site=site,
            quantity=Decimal("6"),
            area_or_comment="EG",
            status="approved",
        ),
        SiteMeasurementEntry(
            measurement_batch=office_batch,
            measurement_item=office_item,
            site=site,
            quantity=Decimal("109"),
            area_or_comment="EG",
            status="billed",
        ),
        SiteMeasurementEntry(
            measurement_batch=office_batch,
            measurement_item=unmatched_item,
            site=site,
            quantity=Decimal("50"),
            area_or_comment="EG",
            status="billed",
        ),
        SiteMeasurementEntry(
            measurement_batch=project_manager_batch,
            measurement_item=project_manager_item,
            site=site,
            quantity=Decimal("5"),
            area_or_comment="EG",
            status="closed",
        ),
        SiteMeasurementEntry(
            measurement_batch=open_batch,
            measurement_item=open_item,
            site=site,
            quantity=Decimal("100"),
            area_or_comment="EG",
            status="submitted",
        ),
        SiteMeasurementEntry(
            measurement_batch=deleted_batch,
            measurement_item=deleted_item,
            site=site,
            quantity=Decimal("100"),
            area_or_comment="EG",
            status="billed",
        ),
    ])
    db.commit()

    timesheet = MeasurementService(db).get_site_measurement_timesheet(site.id)

    assert timesheet.active_batch_ids == [
        worker_batch.id,
        office_batch.id,
        project_manager_batch.id,
        second_worker_batch.id,
    ]
    assert len(timesheet.rows) == 1
    assert timesheet.rows[0].position_id == target_item.id
    assert timesheet.rows[0].measured_quantity == Decimal("124")
    assert timesheet.rows[0].remaining_quantity == Decimal("0")
    assert timesheet.rows[0].progress_percent == 100.0
    assert timesheet.kpi.measured_minutes == Decimal("248")
    assert timesheet.kpi.billed_minutes == Decimal("248")
    assert timesheet.kpi.billed_missing_position_count == 1
    assert timesheet.kpi.completed_batch_count == 4
    assert timesheet.kpi.progress_percent == 100.0


def test_execution_progress_recomputes_after_reopen_edit_reclose_and_archive():
    from app.schemas.measurement import MeasurementEntryCreate

    db = db_session()
    site = create_site(db)
    base = create_measurement_base(db, site)
    target_item = SiteMeasurementItem(
        site=site,
        measurement_base=base,
        position="1.1",
        description="Kabelrinne",
        list_quantity=Decimal("20"),
        unit="m",
        minutes_per_unit=Decimal("1"),
        list_minutes_total=Decimal("20"),
        is_nep=False,
        sort_order=1,
    )
    office_user = User(
        username="execution-progress-office",
        display_name="Büro",
        password_hash="x",
        role=UserRole.OFFICE,
    )
    batch = SiteMeasurementBatch(
        site=site,
        number=1,
        title="Bestehendes Büro-Aufmaß",
        status="billed",
        origin=MeasurementBatchOrigin.OFFICE.value,
        position_mode=MeasurementPositionMode.BLANK.value,
        creator_role_at_creation=UserRole.OFFICE.value,
    )
    free_item = SiteMeasurementItem(
        site=site,
        measurement_batch=batch,
        position="1.1",
        description="Freie Leistung",
        unit="m",
        is_free_position=True,
        sort_order=10,
    )
    entry = SiteMeasurementEntry(
        measurement_batch=batch,
        measurement_item=free_item,
        site=site,
        quantity=Decimal("10"),
        area_or_comment="EG",
        status="billed",
    )
    db.add_all([target_item, office_user, batch, free_item, entry])
    db.commit()
    service = MeasurementService(db)

    initial_timesheet = service.get_site_measurement_timesheet(site.id)
    assert initial_timesheet.rows[0].measured_quantity == Decimal("10")
    assert initial_timesheet.kpi.billed_minutes == Decimal("10")
    assert service.get_site_measurement_timesheet(site.id).kpi.billed_minutes == Decimal("10")

    service.set_site_batch_billing_status(
        site_id=site.id,
        batch_id=batch.id,
        billing_status="submitted",
    )
    reopened_timesheet = service.get_site_measurement_timesheet(site.id)
    assert reopened_timesheet.rows[0].measured_quantity == Decimal("0")
    assert reopened_timesheet.kpi.billed_minutes is None

    service.update_site_entry(
        site_id=site.id,
        batch_id=batch.id,
        entry_id=entry.id,
        payload=MeasurementEntryCreate(area_or_comment="EG", quantity=Decimal("15")),
    )
    service.set_site_batch_billing_status(
        site_id=site.id,
        batch_id=batch.id,
        billing_status="billed",
    )
    reclosed_timesheet = service.get_site_measurement_timesheet(site.id)
    assert reclosed_timesheet.rows[0].measured_quantity == Decimal("15")
    assert reclosed_timesheet.kpi.billed_minutes == Decimal("15")

    service.delete_site_batch(site_id=site.id, batch_id=batch.id, current_user=office_user)
    archived_timesheet = service.get_site_measurement_timesheet(site.id)
    assert archived_timesheet.rows[0].measured_quantity == Decimal("0")
    assert archived_timesheet.kpi.billed_minutes is None

    service.restore_site_batch(site_id=site.id, batch_id=batch.id)
    restored_timesheet = service.get_site_measurement_timesheet(site.id)
    assert restored_timesheet.rows[0].measured_quantity == Decimal("15")
    assert restored_timesheet.kpi.billed_minutes == Decimal("15")


def test_blank_position_persists_project_link_and_uses_it_before_position_fallback():
    db = db_session()
    site = create_site(db)
    active_base = create_measurement_base(db, site)
    other_base = SiteMeasurementBase(
        site=site,
        name="Alte Kalkulation",
        base_type="main_offer",
        status="closed",
        released_to_mobile=False,
    )
    linked_item = SiteMeasurementItem(
        site=site,
        measurement_base=active_base,
        position="1.1",
        description="Kabelrinne",
        list_quantity=Decimal("10"),
        unit="m",
        minutes_per_unit=Decimal("5"),
        list_minutes_total=Decimal("50"),
        is_nep=False,
        sort_order=1,
    )
    ambiguous_item = SiteMeasurementItem(
        site=site,
        measurement_base=other_base,
        position="1.1",
        description="Alte Kabelrinne",
        list_quantity=Decimal("10"),
        unit="m",
        minutes_per_unit=Decimal("99"),
        list_minutes_total=Decimal("990"),
        is_nep=False,
        sort_order=1,
    )
    office_user = User(
        username="linked-office-measurement",
        display_name="Büro",
        password_hash="x",
        role=UserRole.OFFICE,
    )
    batch = SiteMeasurementBatch(
        site=site,
        number=1,
        title="Verknüpftes Büro-Aufmaß",
        status="billed",
        origin=MeasurementBatchOrigin.OFFICE.value,
        position_mode=MeasurementPositionMode.BLANK.value,
        creator_role_at_creation=UserRole.OFFICE.value,
    )
    db.add_all([other_base, linked_item, ambiguous_item, office_user, batch])
    db.commit()

    service = MeasurementService(db)
    created = service.create_site_free_item(
        site_id=site.id,
        batch_id=batch.id,
        current_user=office_user,
        payload=MobileMeasurementFreeItemCreate(
            position="Freie Anzeige",
            description="Aus Kalkulation gewählt",
            unit="m",
            linked_measurement_item_id=linked_item.id,
            quantity=Decimal("3"),
            area_or_comment="EG",
        ),
    )

    timesheet = service.get_site_measurement_timesheet(site.id)
    listed_batch = next(item for item in service.list_site_batches(site.id) if item.id == batch.id)

    assert created.linked_measurement_item_id == linked_item.id
    assert db.get(SiteMeasurementItem, created.id).linked_measurement_item_id == linked_item.id
    assert timesheet.kpi.billed_minutes == Decimal("15")
    assert timesheet.kpi.billed_missing_position_count == 0
    assert listed_batch.reported_minutes == Decimal("15")


def test_blank_position_does_not_guess_between_duplicate_project_positions():
    db = db_session()
    site = create_site(db)
    active_base = create_measurement_base(db, site)
    second_base = SiteMeasurementBase(
        site=site,
        name="Zweite Kalkulation",
        base_type="work_phase",
        status="closed",
        released_to_mobile=False,
    )
    first_item = SiteMeasurementItem(
        site=site,
        measurement_base=active_base,
        position="2.1",
        description="Erste Kalkulation",
        unit="m",
        minutes_per_unit=Decimal("5"),
        is_nep=False,
        sort_order=1,
    )
    duplicate_item = SiteMeasurementItem(
        site=site,
        measurement_base=second_base,
        position=" 2.1 ",
        description="Zweite Kalkulation",
        unit="m",
        minutes_per_unit=Decimal("7"),
        is_nep=False,
        sort_order=1,
    )
    batch = SiteMeasurementBatch(
        site=site,
        number=1,
        title="Nicht eindeutig zuordenbar",
        status="billed",
        origin=MeasurementBatchOrigin.OFFICE.value,
        position_mode=MeasurementPositionMode.BLANK.value,
    )
    free_item = SiteMeasurementItem(
        site=site,
        measurement_batch=batch,
        position="2.1",
        description="Altbestand ohne Link",
        unit="m",
        is_free_position=True,
        sort_order=10,
    )
    entry = SiteMeasurementEntry(
        measurement_batch=batch,
        measurement_item=free_item,
        site=site,
        quantity=Decimal("3"),
        area_or_comment="EG",
        status="billed",
    )
    db.add_all([second_base, first_item, duplicate_item, batch, free_item, entry])
    db.commit()

    timesheet = MeasurementService(db).get_site_measurement_timesheet(site.id)

    assert timesheet.kpi.billed_minutes is None
    assert timesheet.kpi.billed_missing_position_count == 1


def test_office_can_review_and_bill_unsubmitted_measurement_batch():
    db = db_session()
    site = create_site(db)
    base = create_measurement_base(db, site)
    item = SiteMeasurementItem(
        site=site,
        measurement_base=base,
        position="1.01.05.10",
        description="Kabelrinne liefern und montieren",
        list_quantity=Decimal("0.00"),
        unit="m",
        minutes_per_unit=Decimal("19.80"),
        list_minutes_total=Decimal("0.00"),
        is_nep=False,
        sort_order=1,
    )
    review_batch = SiteMeasurementBatch(
        site=site,
        measurement_base=base,
        number=1,
        title="Aufmaß 1",
        status="draft",
    )
    review_entry = SiteMeasurementEntry(
        measurement_batch=review_batch,
        measurement_item=item,
        site=site,
        quantity=Decimal("2.00"),
        area_or_comment="EG",
        status="saved",
    )
    billing_batch = SiteMeasurementBatch(
        site=site,
        measurement_base=base,
        number=2,
        title="Aufmaß 2",
        status="draft",
    )
    billing_entry = SiteMeasurementEntry(
        measurement_batch=billing_batch,
        measurement_item=item,
        site=site,
        quantity=Decimal("3.00"),
        area_or_comment="OG",
        status="saved",
    )
    db.add_all([item, review_batch, review_entry, billing_batch, billing_entry])
    db.commit()

    service = MeasurementService(db)
    reviewed = service.set_site_batch_reviewed(site_id=site.id, batch_id=review_batch.id)
    billed = service.set_site_batch_billing_status(
        site_id=site.id,
        batch_id=billing_batch.id,
        billing_status="billed",
    )

    assert reviewed.status == "reviewed"
    assert billed.status == "billed"
    assert db.get(SiteMeasurementEntry, review_entry.id).status == "reviewed"
    assert db.get(SiteMeasurementEntry, billing_entry.id).status == "billed"


def test_site_measurement_billing_status_and_entry_update():
    from datetime import date

    from app.models.assignment import Assignment
    from app.models.enums import AssignmentType, PersonType, UserRole
    from app.models.person import Person
    from app.models.site_measurement_item import SiteMeasurementBatch, SiteMeasurementEntry
    from app.models.user import User
    from app.schemas.measurement import MeasurementEntryCreate

    db = db_session()
    site = create_site(db)
    base = create_measurement_base(db, site)
    person = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
        person_type=PersonType.INTERNAL,
    )
    user = User(
        username="max",
        display_name="Max Monteur",
        password_hash="x",
        role=UserRole.MONTEUR,
        person=person,
    )
    assignment = Assignment(
        site=site,
        person=person,
        start_date=date(2026, 5, 26),
        end_date=date(2026, 5, 26),
        assignment_type=AssignmentType.REGULAR,
    )
    item = SiteMeasurementItem(
        site=site,
        measurement_base=base,
        position="1.01.05.10",
        description="Kabelrinne liefern und montieren",
        list_quantity=Decimal("0.00"),
        unit="m",
        minutes_per_unit=Decimal("19.80"),
        list_minutes_total=Decimal("0.00"),
        is_nep=False,
        sort_order=1,
    )
    db.add_all([user, assignment, item])
    db.commit()

    service = MeasurementService(db)
    batch = service.create_mobile_batch(assignment_id=assignment.id, current_user=user)

    service.create_mobile_entry(
        assignment_id=assignment.id,
        batch_id=batch.id,
        measurement_item_id=item.id,
        current_user=user,
        payload=MeasurementEntryCreate(area_or_comment="1. OG Flur", quantity=Decimal("10.00")),
    )
    submitted = service.submit_mobile_batch(
        assignment_id=assignment.id,
        batch_id=batch.id,
        current_user=user,
    )
    dashboard_messages = service.list_dashboard_submissions(limit=5)
    updated_entry = service.update_site_entry(
        site_id=site.id,
        batch_id=submitted.id,
        entry_id=service.list_site_batch_items(site_id=site.id, batch_id=submitted.id)[0].entries[0].id,
        payload=MeasurementEntryCreate(area_or_comment="2. OG Technik", quantity=Decimal("12.00")),
    )
    added_review_entry = service.create_site_entry(
        site_id=site.id,
        batch_id=submitted.id,
        measurement_item_id=item.id,
        current_user=user,
        payload=MeasurementEntryCreate(area_or_comment="Dach", quantity=Decimal("5.00")),
    )
    reviewed = service.set_site_batch_reviewed(site_id=site.id, batch_id=submitted.id)
    billed = service.set_site_batch_billing_status(
        site_id=site.id,
        batch_id=reviewed.id,
        billing_status="billed",
    )
    open_again = service.set_site_batch_billing_status(
        site_id=site.id,
        batch_id=reviewed.id,
        billing_status="submitted",
    )

    reset_items = service.reset_site_batch_to_submitted(site_id=site.id, batch_id=reviewed.id)
    reset_entries = reset_items[0].entries
    reset_entry = reset_entries[0]

    stored_batch = db.get(SiteMeasurementBatch, batch.id)
    stored_entry = db.scalar(select(SiteMeasurementEntry).where(SiteMeasurementEntry.measurement_batch_id == batch.id))
    assert dashboard_messages[0].batch_id == batch.id
    assert dashboard_messages[0].site_id == site.id
    assert dashboard_messages[0].submitted_by_name == "Max Monteur"
    assert updated_entry.area_or_comment == "2. OG Technik"
    assert updated_entry.quantity == Decimal("12.00")
    assert db.get(SiteMeasurementEntry, added_review_entry.id) is None
    assert len(reset_entries) == 1
    assert reset_entry.area_or_comment == "1. OG Flur"
    assert reset_entry.quantity == Decimal("10.00")
    assert reviewed.status == "reviewed"
    assert billed.status == "billed"
    assert open_again.status == "submitted"
    assert stored_batch is not None
    assert stored_batch.status == "submitted"
    assert stored_entry is not None
    snapshot = stored_batch.original_submitted_snapshot
    assert snapshot is not None
    assert snapshot["submitted_by_name"] == "Max Monteur"
    assert snapshot["measurement_batch_id"] == batch.id
    assert snapshot["site_id"] == site.id

    assert snapshot["measurement_base_id"] == base.id
    assert snapshot["entries"] == [
        {
            "entry_id": stored_entry.id,
            "measurement_item_id": item.id,
            "site_id": site.id,
            "position": "1.01.05.10",
            "description": "Kabelrinne liefern und montieren",
            "unit": "m",
            "sort_order": 1,
            "area_or_comment": "1. OG Flur",
            "quantity": "10.00",
            "created_by_user_id": user.id,
            "created_at": stored_entry.created_at.isoformat(),
        }
    ]
    assert stored_entry.status == "submitted"
    assert stored_entry.submitted_area_or_comment == "1. OG Flur"
    assert stored_entry.submitted_quantity == Decimal("10.00")


def test_site_free_item_creates_office_extra_position_with_entry():
    from app.models.enums import UserRole
    from app.models.user import User
    from app.schemas.measurement import MeasurementItemUpdate, MobileMeasurementFreeItemCreate

    db = db_session()
    site = create_site(db)
    base = create_measurement_base(db, site)
    user = User(username="office", display_name="Büro", password_hash="x", role=UserRole.OFFICE)
    imported_item = SiteMeasurementItem(
        site=site,
        measurement_base=base,
        position="1.01.05.10",
        description="Kabelrinne liefern und montieren",
        list_quantity=Decimal("0.00"),
        unit="m",
        minutes_per_unit=Decimal("19.80"),
        list_minutes_total=Decimal("0.00"),
        is_nep=False,
        sort_order=10,
    )
    batch = SiteMeasurementBatch(
        site=site,
        measurement_base=base,
        number=1,
        title="Aufmaß 1",
        status="submitted",
    )
    db.add_all([user, imported_item, batch])
    db.commit()

    created = MeasurementService(db).create_site_free_item(
        site_id=site.id,
        batch_id=batch.id,
        current_user=user,
        payload=MobileMeasurementFreeItemCreate(
            position=None,
            description="Zusätzliche Trennstege 60 mm",
            unit="m",
            quantity=Decimal("2.00"),
            area_or_comment="EG Technikraum",
        ),
    )

    stored_item = db.get(SiteMeasurementItem, created.id)
    listed_items = MeasurementService(db).list_site_batch_items(site_id=site.id, batch_id=batch.id)

    assert stored_item is not None
    assert stored_item.position == "FREI-1"
    assert stored_item.is_free_position is True
    assert stored_item.measurement_batch_id == batch.id
    assert stored_item.source_section_key == "office_extra"
    assert stored_item.source_section_title == "Büro-Zusatzposition"
    assert created.entries[0].area_or_comment == "EG Technikraum"
    assert created.entries[0].quantity == Decimal("2.00")
    assert created.entries[0].created_by_user_id == user.id
    assert any(item.id == created.id and item.entries for item in listed_items)

    updated = MeasurementService(db).update_site_free_item(
        site_id=site.id,
        batch_id=batch.id,
        measurement_item_id=created.id,
        payload=MeasurementItemUpdate(position="444.4.999"),
    )
    assert updated.id == created.id
    assert updated.position == "444.4.999"
    assert updated.entries[0].quantity == Decimal("2.00")

    cleared = MeasurementService(db).update_site_free_item(
        site_id=site.id,
        batch_id=batch.id,
        measurement_item_id=created.id,
        payload=MeasurementItemUpdate(position=""),
    )
    assert cleared.id == created.id
    assert cleared.position == "FREI-1"

    with pytest.raises(HTTPException) as delete_error:
        MeasurementService(db).delete_site_free_item(
            site_id=site.id,
            batch_id=batch.id,
            measurement_item_id=created.id,
        )
    assert delete_error.value.status_code == 404
    assert db.get(SiteMeasurementItem, created.id) is not None


def test_site_free_items_append_to_persisted_batch_order_and_keep_it_when_linked():
    from app.schemas.measurement import MeasurementItemUpdate
    from app.services.measurement_pdf_service import MeasurementPdfService

    db = db_session()
    site = create_site(db)
    base = create_measurement_base(db, site)
    office_user = User(
        username="office-column-order",
        display_name="Büro",
        password_hash="x",
        role=UserRole.OFFICE,
    )
    batch = SiteMeasurementBatch(
        site=site,
        measurement_base=base,
        number=7,
        title="Aufmaß 7",
        status="submitted",
        origin=MeasurementBatchOrigin.MONTEUR.value,
        position_mode=MeasurementPositionMode.OFFER_BASED.value,
    )
    offer_items = [
        SiteMeasurementItem(
            site=site,
            measurement_base=base,
            position=position,
            description=f"Angebotsposition {position}",
            unit="m",
            minutes_per_unit=Decimal("1"),
            sort_order=sort_order,
        )
        # The first two legacy positions intentionally share an order and are not
        # numerically sorted. Their stable ID order is the existing visible order.
        for position, sort_order in (("1.03", 10), ("1.01", 10), ("1.05", 50))
    ]
    link_target = SiteMeasurementItem(
        site=site,
        measurement_base=base,
        position="1.04",
        description="Nachträglich verknüpfte Angebotsposition",
        unit="Stck",
        minutes_per_unit=Decimal("2"),
        sort_order=40,
    )
    worker_free_item = SiteMeasurementItem(
        site=site,
        measurement_base=base,
        measurement_batch=batch,
        position="FREI-1",
        description="Freie Monteurposition",
        unit="Stck",
        is_free_position=True,
        sort_order=70,
    )
    unrelated_batch = SiteMeasurementBatch(
        site=site,
        measurement_base=base,
        number=8,
        title="Aufmaß 8",
        status="submitted",
        origin=MeasurementBatchOrigin.MONTEUR.value,
        position_mode=MeasurementPositionMode.OFFER_BASED.value,
    )
    unrelated_free_item = SiteMeasurementItem(
        site=site,
        measurement_base=base,
        measurement_batch=unrelated_batch,
        position="FREI-99",
        description="Position eines anderen Aufmaßes",
        unit="Stck",
        is_free_position=True,
        sort_order=900,
    )
    hidden_item = SiteMeasurementItem(
        site=site,
        measurement_base=base,
        position="9.99",
        description="Ausgeblendete Altposition",
        unit="Stck",
        is_hidden=True,
        sort_order=1000,
    )
    visible_entries = [
        SiteMeasurementEntry(
            measurement_batch=batch,
            measurement_item=item,
            site=site,
            quantity=Decimal("1"),
            area_or_comment="EG",
            status="submitted",
        )
        for item in [*offer_items, worker_free_item]
    ]
    db.add_all(
        [
            office_user,
            batch,
            unrelated_batch,
            *offer_items,
            link_target,
            worker_free_item,
            unrelated_free_item,
            hidden_item,
            *visible_entries,
        ]
    )
    db.commit()
    service = MeasurementService(db)

    appended = service.create_site_free_item(
        site_id=site.id,
        batch_id=batch.id,
        current_user=office_user,
        payload=MobileMeasurementFreeItemCreate(
            position="1.02",
            description="Erste Büroposition",
            unit="m",
            quantity=Decimal("2"),
            area_or_comment="EG",
        ),
    )
    appended_again = service.create_site_free_item(
        site_id=site.id,
        batch_id=batch.id,
        current_user=office_user,
        payload=MobileMeasurementFreeItemCreate(
            position="2.01",
            description="Zweite Büroposition",
            unit="m",
        ),
    )

    assert appended.sort_order == 71
    assert appended_again.sort_order == 72
    reloaded = service.list_site_batch_items(site_id=site.id, batch_id=batch.id)
    visible_ids = {item.id for item in reloaded}
    assert unrelated_free_item.id not in visible_ids
    assert hidden_item.id not in visible_ids
    assert [item.id for item in reloaded if item.entries or item.is_free_position] == [
        offer_items[0].id,
        offer_items[1].id,
        offer_items[2].id,
        worker_free_item.id,
        appended.id,
        appended_again.id,
    ]

    linked = service.update_site_free_item(
        site_id=site.id,
        batch_id=batch.id,
        measurement_item_id=appended.id,
        payload=MeasurementItemUpdate(linked_measurement_item_id=link_target.id),
    )
    assert linked.position == "1.04"
    assert linked.sort_order == 71
    assert [item.id for item in service.list_site_batch_items(site_id=site.id, batch_id=batch.id) if item.entries or item.is_free_position] == [
        offer_items[0].id,
        offer_items[1].id,
        offer_items[2].id,
        worker_free_item.id,
        appended.id,
        appended_again.id,
    ]

    stored_batch = service._get_batch_for_site(batch.id, site.id)
    pdf_positions, _areas, _cells, _totals = MeasurementPdfService(db)._build_matrix(
        stored_batch,
        mode="checked",
    )
    assert [position.item_id for position in pdf_positions] == [
        offer_items[0].id,
        offer_items[1].id,
        offer_items[2].id,
        worker_free_item.id,
        appended.id,
        appended_again.id,
    ]


def test_existing_free_measurement_item_keeps_matrix_totals_separate_and_aggregates_timesheet():
    from app.schemas.measurement import MeasurementItemUpdate
    from app.services.measurement_pdf_service import MeasurementPdfService

    db = db_session()
    site = create_site(db)
    batch_base = create_measurement_base(db, site)
    batch_base.status = "closed"
    batch_base.released_to_mobile = False
    other_base = SiteMeasurementBase(
        site=site,
        name="Andere Angebotsbasis",
        base_type="main_offer",
        status="draft",
        released_to_mobile=False,
    )
    target_item = SiteMeasurementItem(
        site=site,
        measurement_base=batch_base,
        position="1.01",
        description="Kabelrinne 60/200",
        list_quantity=Decimal("100"),
        unit="m",
        minutes_per_unit=Decimal("5"),
        list_minutes_total=Decimal("500"),
        is_nep=False,
        sort_order=10,
    )
    alternate_target_item = SiteMeasurementItem(
        site=site,
        measurement_base=batch_base,
        position="1.02",
        description="Alternative Angebotsposition",
        list_quantity=Decimal("50"),
        unit="m",
        minutes_per_unit=Decimal("6"),
        list_minutes_total=Decimal("300"),
        is_nep=False,
        sort_order=11,
    )
    wrong_base_item = SiteMeasurementItem(
        site=site,
        measurement_base=other_base,
        position="1.01",
        description="Position aus altem Fremdangebot",
        list_quantity=Decimal("100"),
        unit="Stck",
        minutes_per_unit=Decimal("99"),
        list_minutes_total=Decimal("9900"),
        is_nep=False,
        sort_order=10,
    )
    batch = SiteMeasurementBatch(
        site=site,
        measurement_base=batch_base,
        number=1,
        title="Aufmaß 1",
        status="submitted",
        origin=MeasurementBatchOrigin.MONTEUR.value,
        position_mode=MeasurementPositionMode.OFFER_BASED.value,
    )
    free_item = SiteMeasurementItem(
        site=site,
        measurement_base=batch_base,
        measurement_batch=batch,
        position="FREI-1",
        description="Freie Kabelrinne",
        unit="lfm",
        is_free_position=True,
        sort_order=20,
    )
    entries = [
        SiteMeasurementEntry(
            measurement_batch=batch,
            measurement_item=free_item,
            site=site,
            quantity=quantity,
            area_or_comment=area,
            status="submitted",
        )
        for area, quantity in (
            ("EG", Decimal("20")),
            ("1. OG", Decimal("15")),
            ("2. OG", Decimal("10")),
        )
    ]
    target_entry = SiteMeasurementEntry(
        measurement_batch=batch,
        measurement_item=target_item,
        site=site,
        quantity=Decimal("11"),
        area_or_comment="EG",
        status="submitted",
    )
    db.add_all([
        other_base,
        target_item,
        alternate_target_item,
        wrong_base_item,
        batch,
        free_item,
        target_entry,
        *entries,
    ])
    db.commit()
    service = MeasurementService(db)
    free_item_id = free_item.id
    entry_state = [(entry.id, entry.area_or_comment, entry.quantity) for entry in entries]

    with pytest.raises(HTTPException) as wrong_base_error:
        service.update_site_free_item(
            site_id=site.id,
            batch_id=batch.id,
            measurement_item_id=free_item.id,
            payload=MeasurementItemUpdate(linked_measurement_item_id=wrong_base_item.id),
        )
    assert wrong_base_error.value.status_code == 400
    assert db.get(SiteMeasurementItem, free_item.id).linked_measurement_item_id is None

    typed_update = service.update_site_free_item(
        site_id=site.id,
        batch_id=batch.id,
        measurement_item_id=free_item.id,
        payload=MeasurementItemUpdate(position=target_item.position),
    )
    assert typed_update.linked_measurement_item_id == target_item.id
    assert typed_update.position == "1.01"
    assert typed_update.description == "Freie Kabelrinne"
    assert typed_update.unit == "lfm"

    reassigned = service.update_site_free_item(
        site_id=site.id,
        batch_id=batch.id,
        measurement_item_id=free_item.id,
        payload=MeasurementItemUpdate(linked_measurement_item_id=alternate_target_item.id),
    )
    assert reassigned.linked_measurement_item_id == alternate_target_item.id
    assert reassigned.position == "1.02"

    reassigned_back = service.update_site_free_item(
        site_id=site.id,
        batch_id=batch.id,
        measurement_item_id=free_item.id,
        payload=MeasurementItemUpdate(position=target_item.position),
    )
    assert reassigned_back.linked_measurement_item_id == target_item.id
    assert reassigned_back.position == "1.01"

    cleared = service.update_site_free_item(
        site_id=site.id,
        batch_id=batch.id,
        measurement_item_id=free_item.id,
        payload=MeasurementItemUpdate(linked_measurement_item_id=None),
    )
    assert cleared.linked_measurement_item_id is None
    assert cleared.position == "FREI-1"
    assert cleared.description == "Freie Kabelrinne"
    assert cleared.unit == "lfm"

    updated = service.update_site_free_item(
        site_id=site.id,
        batch_id=batch.id,
        measurement_item_id=free_item.id,
        payload=MeasurementItemUpdate(
            position="Manipulierte Nummer",
            description="Manipulierter Text",
            unit="falsch",
            linked_measurement_item_id=target_item.id,
        ),
    )

    assert updated.id == free_item_id
    assert updated.is_free_position is True
    assert updated.linked_measurement_item_id == target_item.id
    assert updated.position == "1.01"
    assert updated.description == "Freie Kabelrinne"
    assert updated.unit == "lfm"
    assert updated.sort_order == 20
    assert [(entry.id, entry.area_or_comment, entry.quantity) for entry in updated.entries] == entry_state
    assert updated.reported_quantity == Decimal("45")
    assert [(entry.id, entry.area_or_comment, entry.quantity) for entry in entries] == entry_state
    reloaded = next(
        item
        for item in service.list_site_batch_items(site_id=site.id, batch_id=batch.id)
        if item.id == free_item_id
    )
    assert reloaded.linked_measurement_item_id == target_item.id
    assert [(entry.id, entry.area_or_comment, entry.quantity) for entry in reloaded.entries] == entry_state

    stored_batch = service._get_batch_for_site(batch.id, site.id)
    positions, areas, _cells, totals = MeasurementPdfService(db)._build_matrix(
        stored_batch,
        mode="checked",
    )
    assert [(position.item_id, position.position, position.description, position.unit) for position in positions] == [
        (target_item.id, "1.01", "Kabelrinne 60/200", "m"),
        (free_item_id, "1.01", "Freie Kabelrinne", "lfm"),
    ]
    assert [area.label for area in areas] == ["EG", "1. OG", "2. OG"]
    assert totals == {
        target_item.id: Decimal("11"),
        free_item_id: Decimal("45"),
    }

    batch_base.status = "active"
    batch_base.released_to_mobile = True
    other_base.status = "closed"
    other_base.released_to_mobile = False
    stored_batch.status = "billed"
    db.commit()
    timesheet = service.get_site_measurement_timesheet(site.id)
    target_row = next(row for row in timesheet.rows if row.position_id == target_item.id)
    assert target_row.description == "Kabelrinne 60/200"
    assert target_row.measured_quantity == Decimal("56")
    assert target_row.measured_minutes == Decimal("280")

    correction_batch = SiteMeasurementBatch(
        site=site,
        measurement_base=batch_base,
        number=2,
        title="Korrekturaufmaß",
        status="billed",
        origin=MeasurementBatchOrigin.OFFICE.value,
        position_mode=MeasurementPositionMode.OFFER_BASED.value,
    )
    correction_item = SiteMeasurementItem(
        site=site,
        measurement_base=batch_base,
        measurement_batch=correction_batch,
        linked_measurement_item=target_item,
        position=target_item.position,
        description="Korrektur Kabelrinne",
        unit="m",
        is_free_position=True,
        sort_order=20,
    )
    negative_entry = SiteMeasurementEntry(
        measurement_batch=correction_batch,
        measurement_item=correction_item,
        site=site,
        quantity=Decimal("-60"),
        area_or_comment="Korrektur EG",
        status="billed",
    )
    db.add_all([correction_batch, correction_item, negative_entry])
    db.commit()

    negative_timesheet = service.get_site_measurement_timesheet(site.id)
    negative_target_row = next(
        row for row in negative_timesheet.rows if row.position_id == target_item.id
    )
    assert negative_target_row.measured_quantity == Decimal("-4")
    assert negative_target_row.measured_minutes == Decimal("-20")
    assert negative_target_row.remaining_quantity == Decimal("104")
    assert negative_target_row.progress_percent == pytest.approx(-4.0)
    assert negative_target_row.is_captured is True

    zero_batch = SiteMeasurementBatch(
        site=site,
        measurement_base=batch_base,
        number=3,
        title="Ausgleichsaufmaß",
        status="billed",
        origin=MeasurementBatchOrigin.OFFICE.value,
        position_mode=MeasurementPositionMode.OFFER_BASED.value,
    )
    zero_item = SiteMeasurementItem(
        site=site,
        measurement_base=batch_base,
        measurement_batch=zero_batch,
        linked_measurement_item=target_item,
        position=target_item.position,
        description="Ausgleich Kabelrinne",
        unit="m",
        is_free_position=True,
        sort_order=20,
    )
    zero_entry = SiteMeasurementEntry(
        measurement_batch=zero_batch,
        measurement_item=zero_item,
        site=site,
        quantity=Decimal("4"),
        area_or_comment="Ausgleich EG",
        status="billed",
    )
    db.add_all([zero_batch, zero_item, zero_entry])
    db.commit()

    zero_timesheet = service.get_site_measurement_timesheet(site.id)
    zero_target_row = next(
        row for row in zero_timesheet.rows if row.position_id == target_item.id
    )
    assert zero_target_row.measured_quantity == Decimal("0")
    assert zero_target_row.measured_minutes == Decimal("0")
    assert zero_target_row.remaining_quantity == Decimal("100")
    assert zero_target_row.progress_percent == pytest.approx(0.0)
    assert zero_target_row.is_captured is True

def test_multiple_free_measurements_can_share_a_used_target_and_keep_status_guards():
    from app.schemas.measurement import MeasurementItemUpdate

    db = db_session()
    site = create_site(db)
    base = create_measurement_base(db, site)
    target_item = SiteMeasurementItem(
        site=site,
        measurement_base=base,
        position="2.01",
        description="Angebotsposition",
        unit="m",
        minutes_per_unit=Decimal("4"),
        is_nep=False,
        sort_order=10,
    )
    batch = SiteMeasurementBatch(
        site=site,
        measurement_base=base,
        number=2,
        title="Aufmaß 2",
        status="submitted",
        origin=MeasurementBatchOrigin.MONTEUR.value,
        position_mode=MeasurementPositionMode.OFFER_BASED.value,
    )
    free_item = SiteMeasurementItem(
        site=site,
        measurement_base=base,
        measurement_batch=batch,
        position="FREI-1",
        description="Freie Position",
        unit="m",
        is_free_position=True,
        sort_order=20,
    )
    second_free_item = SiteMeasurementItem(
        site=site,
        measurement_base=base,
        measurement_batch=batch,
        position="FREI-2",
        description="Weitere freie Position",
        unit="Stck",
        is_free_position=True,
        sort_order=21,
    )
    existing_target_entry = SiteMeasurementEntry(
        measurement_batch=batch,
        measurement_item=target_item,
        site=site,
        quantity=Decimal("3"),
        area_or_comment="EG",
        status="submitted",
    )
    first_free_entry = SiteMeasurementEntry(
        measurement_batch=batch,
        measurement_item=free_item,
        site=site,
        quantity=Decimal("5"),
        area_or_comment="1. OG",
        status="submitted",
    )
    second_free_entry = SiteMeasurementEntry(
        measurement_batch=batch,
        measurement_item=second_free_item,
        site=site,
        quantity=Decimal("3"),
        area_or_comment="2. OG",
        status="submitted",
    )
    db.add_all([
        target_item,
        batch,
        free_item,
        second_free_item,
        existing_target_entry,
        first_free_entry,
        second_free_entry,
    ])
    db.commit()
    service = MeasurementService(db)

    first_link = service.update_site_free_item(
        site_id=site.id,
        batch_id=batch.id,
        measurement_item_id=free_item.id,
        payload=MeasurementItemUpdate(linked_measurement_item_id=target_item.id),
    )
    second_link = service.update_site_free_item(
        site_id=site.id,
        batch_id=batch.id,
        measurement_item_id=second_free_item.id,
        payload=MeasurementItemUpdate(linked_measurement_item_id=target_item.id),
    )
    assert first_link.linked_measurement_item_id == target_item.id
    assert second_link.linked_measurement_item_id == target_item.id
    assert first_link.description == "Freie Position"
    assert second_link.description == "Weitere freie Position"

    batch.status = "billed"
    db.commit()
    target_row = next(
        row
        for row in service.get_site_measurement_timesheet(site.id).rows
        if row.position_id == target_item.id
    )
    assert target_row.measured_quantity == Decimal("11")
    assert target_row.measured_minutes == Decimal("44")

    batch.status = "customer_signed"
    batch.customer_signed_at = datetime.now(timezone.utc)
    db.commit()
    with pytest.raises(HTTPException) as locked_error:
        service.update_site_free_item(
            site_id=site.id,
            batch_id=batch.id,
            measurement_item_id=free_item.id,
            payload=MeasurementItemUpdate(linked_measurement_item_id=target_item.id),
        )
    assert locked_error.value.status_code == 409
    assert "Unterschriebene oder abgeschlossene" in locked_error.value.detail


def test_measurement_time_analysis_groups_work_times_and_extra_work_by_submitted_batches():
    from app.models.enums import PersonType
    from app.models.extra_work_ticket import ExtraWorkTicket, ExtraWorkTicketEntry
    from app.models.person import Person
    from app.models.site_measurement_item import SiteMeasurementEntry
    from app.models.work_time_entry import WorkTimeEntry

    db = db_session()
    site = create_site(db)
    base = create_measurement_base(db, site)
    person = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
        person_type=PersonType.INTERNAL,
    )
    item = SiteMeasurementItem(
        site=site,
        measurement_base=base,
        position="1",
        description="Montage",
        list_quantity=Decimal("0"),
        unit="Std",
        minutes_per_unit=Decimal("60"),
        list_minutes_total=Decimal("0"),
        is_nep=False,
        sort_order=1,
    )
    db.add_all([person, item])
    db.flush()

    batch_1 = SiteMeasurementBatch(
        site=site,
        measurement_base=base,
        number=1,
        title="Hauptauftrag",
        status="submitted",
        submitted_at=datetime(2026, 8, 16, 12, 0, tzinfo=timezone.utc),
    )
    batch_2 = SiteMeasurementBatch(
        site=site,
        measurement_base=base,
        number=2,
        title="Hauptauftrag",
        status="submitted",
        submitted_at=datetime(2026, 8, 19, 12, 0, tzinfo=timezone.utc),
    )
    batch_3 = SiteMeasurementBatch(
        site=site,
        measurement_base=base,
        number=3,
        title="Hauptauftrag",
        status="submitted",
        submitted_at=datetime(2026, 9, 13, 12, 0, tzinfo=timezone.utc),
    )
    db.add_all([batch_1, batch_2, batch_3])
    db.flush()
    db.add_all(
        [
            SiteMeasurementEntry(
                measurement_batch=batch_1,
                measurement_item=item,
                site=site,
                quantity=Decimal("10"),
                area_or_comment="KW33",
                status="submitted",
            ),
            SiteMeasurementEntry(
                measurement_batch=batch_2,
                measurement_item=item,
                site=site,
                quantity=Decimal("20"),
                area_or_comment="KW34",
                status="submitted",
            ),
            SiteMeasurementEntry(
                measurement_batch=batch_3,
                measurement_item=item,
                site=site,
                quantity=Decimal("30"),
                area_or_comment="KW37",
                status="submitted",
            ),
        ]
    )

    def work_entry(work_date: date, hours: int) -> WorkTimeEntry:
        return WorkTimeEntry(
            person=person,
            site=site,
            work_date=work_date,
            work_minutes=hours * 60,
            break_minutes=0,
            travel_minutes=0,
            status="reviewed",
            time_review_status="manually_approved",
        )

    db.add_all(
        [
            work_entry(date(2026, 8, 14), 40),
            work_entry(date(2026, 8, 18), 20),
            work_entry(date(2026, 8, 20), 25),
            work_entry(date(2026, 8, 28), 80),
            work_entry(date(2026, 9, 4), 25),
            work_entry(date(2026, 9, 11), 5),
        ]
    )

    def ticket(sequence: int, relevant_at: datetime, hours: int) -> ExtraWorkTicket:
        item_ticket = ExtraWorkTicket(
            site=site,
            sequence_number=sequence,
            display_number=f"8007.SZ{sequence:02d}",
            title=f"Zusatz {sequence}",
            status="submitted",
            submitted_at=relevant_at,
        )
        item_ticket.entries = [
            ExtraWorkTicketEntry(
                site=site,
                component="Bauteil",
                floor="EG",
                worker_rows=[{"worker_name": "Max Monteur", "monday_hours": hours}],
            )
        ]
        return item_ticket

    archived_ticket = ticket(5, datetime(2026, 8, 13, 12, 0, tzinfo=timezone.utc), 99)
    archived_ticket.deleted_at = datetime(2026, 8, 18, 12, 0, tzinfo=timezone.utc)
    db.add_all(
        [
            ticket(1, datetime(2026, 8, 12, 12, 0, tzinfo=timezone.utc), 3),
            ticket(2, datetime(2026, 8, 17, 12, 0, tzinfo=timezone.utc), 4),
            ticket(3, datetime(2026, 9, 14, 12, 0, tzinfo=timezone.utc), 5),
            ticket(4, datetime(2026, 9, 21, 12, 0, tzinfo=timezone.utc), 6),
            archived_ticket,
        ]
    )
    db.commit()

    analysis = MeasurementService(db).get_site_measurement_time_analysis(site.id)

    assert [row.actual_minutes for row in analysis.rows] == [
        Decimal("2400"),
        Decimal("1200"),
        Decimal("8100"),
    ]
    assert [row.deviation_minutes for row in analysis.rows] == [
        Decimal("-1380"),
        Decimal("0"),
        Decimal("-5640"),
    ]
    assert [ticket.display_number for ticket in analysis.rows[0].extra_work_tickets] == [
        "8007.SZ01",
        "8007.SZ02",
    ]
    assert analysis.rows[1].extra_work_tickets == []
    assert [ticket.display_number for ticket in analysis.rows[2].extra_work_tickets] == [
        "8007.SZ03",
        "8007.SZ04",
    ]


def test_measurement_time_analysis_preserves_signed_measurement_minutes():
    from app.models.site_measurement_item import SiteMeasurementEntry

    db = db_session()
    site = create_site(db)
    base = create_measurement_base(db, site)
    item = SiteMeasurementItem(
        site=site,
        measurement_base=base,
        position="K1",
        description="Korrektur Montage",
        list_quantity=Decimal("10"),
        unit="m",
        minutes_per_unit=Decimal("12"),
        list_minutes_total=Decimal("120"),
        is_nep=False,
        sort_order=1,
    )
    batch = SiteMeasurementBatch(
        site=site,
        measurement_base=base,
        number=1,
        title="Korrekturaufmaß",
        status="submitted",
        submitted_at=datetime(2026, 8, 16, 12, 0, tzinfo=timezone.utc),
    )
    entry = SiteMeasurementEntry(
        measurement_batch=batch,
        measurement_item=item,
        site=site,
        quantity=Decimal("-8.50"),
        area_or_comment="Korrektur EG",
        status="submitted",
    )
    db.add_all([item, batch, entry])
    db.commit()

    analysis = MeasurementService(db).get_site_measurement_time_analysis(site.id)

    assert analysis.rows[0].measurement_minutes == Decimal("-102.00")
    assert analysis.rows[0].planned_minutes == Decimal("-102.00")
    assert analysis.rows[0].deviation_minutes == Decimal("-102.00")
    assert analysis.rows[0].consumption_percent is None
    assert analysis.totals.planned_minutes == Decimal("-102.00")
    assert analysis.totals.deviation_minutes == Decimal("-102.00")


def test_measurement_time_analysis_counts_external_planned_people_like_execution_progress():
    from app.models.assignment import Assignment
    from app.models.enums import PersonType
    from app.models.person import Person
    from app.models.site_measurement_item import SiteMeasurementEntry
    from app.models.work_time_entry import WorkTimeEntry

    db = db_session()
    site = create_site(db)
    base = create_measurement_base(db, site)
    work_date = date(2026, 8, 14)
    internal = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
        person_type=PersonType.INTERNAL,
    )
    external_one = Person(
        first_name="Eva",
        last_name="Extern",
        display_name="Eva Extern",
        short_code="EE",
        person_type=PersonType.EXTERNAL,
    )
    external_two = Person(
        first_name="Tom",
        last_name="Temp",
        display_name="Tom Temp",
        short_code="TT",
        person_type=PersonType.EXTERNAL_TEMP,
    )
    item = SiteMeasurementItem(
        site=site,
        measurement_base=base,
        position="1",
        description="Montage",
        list_quantity=Decimal("0"),
        unit="Std",
        minutes_per_unit=Decimal("60"),
        list_minutes_total=Decimal("0"),
        is_nep=False,
        sort_order=1,
    )
    db.add_all([internal, external_one, external_two, item])
    db.flush()

    batch = SiteMeasurementBatch(
        site=site,
        measurement_base=base,
        number=1,
        title="Hauptauftrag",
        status="submitted",
        submitted_at=datetime(2026, 8, 16, 12, 0, tzinfo=timezone.utc),
    )
    db.add(batch)
    db.flush()
    db.add_all(
        [
            SiteMeasurementEntry(
                measurement_batch=batch,
                measurement_item=item,
                site=site,
                quantity=Decimal("32"),
                area_or_comment="KW33",
                status="submitted",
            ),
            WorkTimeEntry(
                person=internal,
                site=site,
                work_date=work_date,
                work_minutes=8 * 60,
                break_minutes=0,
                travel_minutes=0,
                status="reviewed",
                time_review_status="manually_approved",
            ),
            Assignment(
                site=site,
                person=external_one,
                start_date=work_date,
                end_date=work_date,
            ),
            Assignment(
                site=site,
                person=external_two,
                start_date=work_date,
                end_date=work_date,
            ),
        ]
    )
    db.commit()

    analysis = MeasurementService(db).get_site_measurement_time_analysis(site.id)

    assert analysis.rows[0].planned_minutes == Decimal("1920")
    assert analysis.rows[0].actual_minutes == Decimal("1440")
    assert analysis.rows[0].deviation_minutes == Decimal("480")
    assert analysis.rows[0].consumption_percent == 75
    assert analysis.totals.planned_minutes == Decimal("1920")
    assert analysis.totals.actual_minutes == Decimal("1440")
    assert analysis.totals.deviation_minutes == Decimal("480")
    assert analysis.totals.consumption_percent == 75


def test_dashboard_submissions_for_project_manager_are_scoped_to_assigned_sites():
    from app.models.enums import PersonType, UserRole
    from app.models.person import Person
    from app.models.user import User

    db = db_session()
    own_manager = Person(
        first_name="Axel",
        last_name="Biesewig",
        display_name="Axel Biesewig",
        short_code="AB",
        person_type=PersonType.INTERNAL,
    )
    other_manager = Person(
        first_name="Klara",
        last_name="Extern",
        display_name="Klara Extern",
        short_code="KE",
        person_type=PersonType.INTERNAL,
    )
    project_manager_user = User(
        username="axel",
        display_name="Axel Biesewig",
        password_hash="x",
        role=UserRole.PROJECT_MANAGER,
        person=own_manager,
    )
    unrelated_project_manager_user = User(
        username="no-sites",
        display_name="Projektleiter ohne Baustellen",
        password_hash="x",
        role=UserRole.PROJECT_MANAGER,
    )
    admin_user = User(
        username="admin",
        display_name="Administrator",
        password_hash="x",
        role=UserRole.ADMIN,
    )
    own_site = create_site(db)
    own_site.name = "Eigene Baustelle"
    own_site.project_manager = own_manager
    other_site = create_site(db)
    other_site.name = "Fremde Baustelle"
    other_site.project_manager = other_manager
    own_base = create_measurement_base(db, own_site)
    other_base = create_measurement_base(db, other_site)
    own_batch = SiteMeasurementBatch(
        site=own_site,
        measurement_base=own_base,
        number=1,
        title="Aufmaß eigene Baustelle",
        status="submitted",
        submitted_at=datetime(2026, 6, 12, 8, 0, tzinfo=timezone.utc),
    )
    other_batch = SiteMeasurementBatch(
        site=other_site,
        measurement_base=other_base,
        number=1,
        title="Aufmaß fremde Baustelle",
        status="submitted",
        submitted_at=datetime(2026, 6, 12, 9, 0, tzinfo=timezone.utc),
    )
    db.add_all(
        [
            own_manager,
            other_manager,
            project_manager_user,
            unrelated_project_manager_user,
            admin_user,
            own_batch,
            other_batch,
        ]
    )
    db.commit()

    service = MeasurementService(db)

    project_manager_messages = service.list_dashboard_submissions(
        limit=5,
        current_user=project_manager_user,
    )
    unrelated_project_manager_messages = service.list_dashboard_submissions(
        limit=5,
        current_user=unrelated_project_manager_user,
    )
    admin_messages = service.list_dashboard_submissions(limit=5, current_user=admin_user)

    assert [message.batch_id for message in project_manager_messages] == [own_batch.id]
    assert unrelated_project_manager_messages == []
    assert {message.batch_id for message in admin_messages} == {own_batch.id, other_batch.id}


def test_dashboard_submissions_include_submitted_extra_work_tickets():
    from app.models.enums import PersonType, UserRole
    from app.models.extra_work_ticket import ExtraWorkTicket
    from app.models.person import Person
    from app.models.user import User

    db = db_session()
    site = create_site(db)
    site.name = "Schüchtermann Klinik"
    site.site_number = "8007"
    person = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
        person_type=PersonType.INTERNAL,
    )
    user = User(
        username="max",
        display_name="Max Monteur",
        password_hash="x",
        role=UserRole.MONTEUR,
        person=person,
    )
    ticket = ExtraWorkTicket(
        site=site,
        sequence_number=1,
        display_number="8007.SZ01",
        status="submitted",
        submitted_by=user,
        submitted_at=datetime(2026, 6, 19, 7, 30, tzinfo=timezone.utc),
    )
    archived_ticket = ExtraWorkTicket(
        site=site,
        sequence_number=2,
        display_number="8007.SZ02",
        status="submitted",
        submitted_by=user,
        submitted_at=datetime(2026, 6, 19, 8, 0, tzinfo=timezone.utc),
        deleted_at=datetime(2026, 6, 19, 9, 0, tzinfo=timezone.utc),
    )
    db.add_all([person, user, ticket, archived_ticket])
    db.commit()

    service = MeasurementService(db)
    dashboard_messages = service.list_dashboard_submissions(limit=5)
    dashboard_summary = service.get_dashboard_messages_summary(limit=5)

    assert len(dashboard_messages) == 1
    assert dashboard_summary.open_count == 1
    assert dashboard_summary.latest_messages[0].message_key == dashboard_messages[0].message_key
    assert dashboard_messages[0].message_key == f"extra_work_submitted:{ticket.id}"
    assert dashboard_messages[0].message_type == "extra_work_submitted"
    assert dashboard_messages[0].batch_id is None
    assert dashboard_messages[0].extra_work_ticket_id == ticket.id
    assert dashboard_messages[0].title == "Stundenzettel 8007.SZ01"
    assert dashboard_messages[0].site_name == "Schüchtermann Klinik"
    assert dashboard_messages[0].site_number == "8007"
    assert dashboard_messages[0].submitted_by_name == "Max Monteur"
    assert dashboard_messages[0].event_at == ticket.submitted_at

    service.dismiss_dashboard_message(message_key=dashboard_messages[0].message_key, current_user=user)
    dismissed_summary = service.get_dashboard_messages_summary(limit=5, current_user=user)
    assert dismissed_summary.open_count == 0
    assert dismissed_summary.latest_messages == []
    assert service.list_dashboard_submissions(limit=5, current_user=user) == []
    assert service.list_dashboard_submissions(limit=5)[0].extra_work_ticket_id == ticket.id


def test_dashboard_submissions_include_customer_signed_batches_until_billed():
    from datetime import date

    from app.models.assignment import Assignment
    from app.models.enums import AssignmentType, PersonType, UserRole
    from app.models.person import Person
    from app.models.site_measurement_item import SiteMeasurementBatch
    from app.models.user import User
    from app.schemas.measurement import CustomerSignatureCreate, MeasurementEntryCreate, WorkerSignatureCreate

    db = db_session()
    site = create_site(db)
    site.name = "Schüchtermann Klinik"
    site.site_number = "8007"
    site.street = "Klinikweg"
    site.house_number = "8"
    site.postal_code = "77815"
    site.city = "Buehl"
    base = create_measurement_base(db, site)
    person = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
        person_type=PersonType.INTERNAL,
    )
    user = User(
        username="max-signature",
        display_name="Max Monteur",
        password_hash="x",
        role=UserRole.MONTEUR,
        person=person,
    )
    assignment = Assignment(
        site=site,
        person=person,
        start_date=date(2026, 6, 10),
        end_date=date(2026, 6, 10),
        assignment_type=AssignmentType.REGULAR,
    )
    item = SiteMeasurementItem(
        site=site,
        measurement_base=base,
        position="1.01.05.10",
        description="Kabelrinne liefern und montieren",
        list_quantity=Decimal("0.00"),
        unit="m",
        minutes_per_unit=Decimal("19.80"),
        list_minutes_total=Decimal("0.00"),
        is_nep=False,
        sort_order=1,
    )
    db.add_all([user, assignment, item])
    db.commit()

    service = MeasurementService(db)
    batch = service.create_mobile_batch(assignment_id=assignment.id, current_user=user)
    service.create_mobile_entry(
        assignment_id=assignment.id,
        batch_id=batch.id,
        measurement_item_id=item.id,
        current_user=user,
        payload=MeasurementEntryCreate(area_or_comment="EG", quantity=Decimal("12.00")),
    )
    signature_payload = CustomerSignatureCreate(
        customer_name="Kunde Beispiel",
        signature_strokes=[
            [{"x": 0.1, "y": 0.5}, {"x": 0.4, "y": 0.45}, {"x": 0.8, "y": 0.55}]
        ],
    )
    with pytest.raises(HTTPException) as blocked_signature:
        service.sign_mobile_batch(
            assignment_id=assignment.id,
            batch_id=batch.id,
            current_user=user,
            payload=signature_payload,
        )
    assert blocked_signature.value.status_code == 403

    person.can_sign_measurements_immediately = True
    db.commit()
    signed = service.sign_mobile_batch(
        assignment_id=assignment.id,
        batch_id=batch.id,
        current_user=user,
        payload=signature_payload,
    )

    dashboard_messages = service.list_dashboard_submissions(limit=5)
    dashboard_summary = service.get_dashboard_messages_summary(limit=5)

    assert dashboard_summary.open_count == 1
    assert dashboard_summary.latest_messages[0].message_key == dashboard_messages[0].message_key
    assert dashboard_messages[0].batch_id == batch.id
    assert dashboard_messages[0].message_type == "measurement_customer_signed"
    assert dashboard_messages[0].event_at == signed.customer_signed_at
    assert dashboard_messages[0].customer_signature_name == "Kunde Beispiel"
    assert dashboard_messages[0].submitted_by_name is None
    assert dashboard_messages[0].message_key == f"measurement_customer_signed:{batch.id}"
    assert signed.customer_signature_place == "Klinikweg 8, 77815 Buehl"

    service.dismiss_dashboard_message(message_key=dashboard_messages[0].message_key, current_user=user)
    dismissed_summary = service.get_dashboard_messages_summary(limit=5, current_user=user)
    assert dismissed_summary.open_count == 0
    assert dismissed_summary.latest_messages == []
    assert service.list_dashboard_submissions(limit=5, current_user=user) == []
    assert service.list_dashboard_submissions(limit=5)[0].batch_id == batch.id

    stored_batch = db.get(SiteMeasurementBatch, batch.id)
    assert stored_batch is not None
    assert stored_batch.status == "customer_signed"
    assert stored_batch.customer_signature_place == "Klinikweg 8, 77815 Buehl"
    assert stored_batch.customer_signed_snapshot is not None
    assert stored_batch.customer_signed_snapshot["version_label"] == "customer_signed"

    with pytest.raises(HTTPException) as locked_entry:
        service.create_mobile_entry(
            assignment_id=assignment.id,
            batch_id=batch.id,
            measurement_item_id=item.id,
            current_user=user,
            payload=MeasurementEntryCreate(area_or_comment="OG", quantity=Decimal("1.00")),
        )
    assert locked_entry.value.status_code == 409

    worker_signed = service.sign_mobile_batch_worker(
        assignment_id=assignment.id,
        batch_id=batch.id,
        current_user=user,
        payload=WorkerSignatureCreate(
            worker_name="Max Monteur",
            signature_strokes=[
                [{"x": 0.1, "y": 0.4}, {"x": 0.5, "y": 0.45}, {"x": 0.9, "y": 0.5}]
            ],
        ),
    )
    assert worker_signed.worker_signature_name == "Max Monteur"
    assert worker_signed.worker_signed_at is not None
    assert worker_signed.customer_signed_at == signed.customer_signed_at
    assert worker_signed.is_locked_for_worker is True

    from app.services.measurement_pdf_service import MeasurementPdfService

    pdf_content, filename = MeasurementPdfService(db).build_batch_pdf(
        site_id=site.id,
        batch_id=batch.id,
        mode="checked",
    )

    assert filename == "Aufmass_geprueft_8007.01.pdf"
    assert b"Kunde Beispiel" in pdf_content
    assert b"Klinikweg 8" in pdf_content
    assert b"Adresse:" in pdf_content
    assert b"Monteur:" in pdf_content
    assert b"Eingereicht:" in pdf_content
    assert b"Status:" in pdf_content
    assert b"1 0 0 1 0 32 cm" not in pdf_content
    assert b"0.05 0.12 0.24 RG" in pdf_content

    stored_batch.status = "billed"
    db.commit()

    assert service.list_dashboard_submissions(limit=5) == []


def test_measurement_pdf_signature_place_uses_site_city():
    from app.services.measurement_pdf_service import _site_signature_city

    db = db_session()
    site = create_site(db)
    site.address = "Ulmenallee 5, 49214 Bad Rothenfelde"
    site.city = "Bad Rothenfelde"

    assert _site_signature_city(site, "Ulmenallee 5, 49214 Bad Rothenfelde") == "Bad Rothenfelde"


def test_measurement_pdf_signature_place_extracts_city_from_legacy_address():
    from app.services.measurement_pdf_service import _site_signature_city

    db = db_session()
    site = create_site(db)
    site.city = None
    site.address = None
    site.location = None

    assert _site_signature_city(site, "Ulmenallee 5, 49214 Bad Rothenfelde") == "Bad Rothenfelde"


def test_measurement_pdf_matrix_separates_original_and_checked_values():
    from datetime import datetime, timezone

    from app.models.site_measurement_item import SiteMeasurementBatch, SiteMeasurementEntry
    from app.services.measurement_pdf_service import MeasurementPdfService

    db = db_session()
    site = create_site(db)
    base = create_measurement_base(db, site)
    item = SiteMeasurementItem(
        site=site,
        measurement_base=base,
        position="1.01.05.10",
        description="Kabelrinne liefern und montieren",
        list_quantity=Decimal("0.00"),
        unit="m",
        minutes_per_unit=Decimal("19.80"),
        list_minutes_total=Decimal("0.00"),
        is_nep=False,
        sort_order=1,
    )
    batch = SiteMeasurementBatch(
        site=site,
        measurement_base=base,
        number=1,
        title="Aufmaß 1",
        status="billed",
        original_submitted_snapshot={
            "version": 1,
            "measurement_batch_id": 1,
            "site_id": site.id,
            "measurement_base_id": base.id,
            "number": 1,
            "title": "Aufmaß 1",
            "entries": [
                {
                    "entry_id": 1,
                    "measurement_item_id": 1,
                    "site_id": site.id,
                    "position": "1.01.05.10",
                    "description": "Kabelrinne liefern und montieren",
                    "unit": "m",
                    "sort_order": 1,
                    "area_or_comment": "EG",
                    "quantity": "10.00",
                }
            ],
        },
    )
    entry = SiteMeasurementEntry(
        measurement_batch=batch,
        measurement_item=item,
        site=site,
        quantity=Decimal("12.00"),
        area_or_comment="EG",
        status="billed",
    )
    db.add_all([item, batch, entry])
    db.commit()

    pdf_service = MeasurementPdfService(db)
    _positions, _areas, original_cells, original_totals = pdf_service._build_matrix(batch, mode="original")
    _positions, _areas, checked_cells, checked_totals = pdf_service._build_matrix(batch, mode="checked")

    original_cell = original_cells[("eg", item.id)]
    checked_cell = checked_cells[("eg", item.id)]
    assert original_cell.quantity == Decimal("10.00")
    assert original_cell.original_quantity is None
    assert original_totals[item.id] == Decimal("10.00")
    assert checked_cell.quantity == Decimal("12.00")
    assert checked_cell.original_quantity is None
    assert checked_cell.is_corrected is False
    assert checked_totals[item.id] == Decimal("12.00")

    batch.customer_signed_at = datetime.now(timezone.utc)
    batch.customer_signed_snapshot = batch.original_submitted_snapshot
    _positions, _areas, signed_checked_cells, signed_checked_totals = pdf_service._build_matrix(batch, mode="checked")

    signed_checked_cell = signed_checked_cells[("eg", item.id)]
    assert signed_checked_cell.quantity == Decimal("12.00")
    assert signed_checked_cell.original_quantity == Decimal("10.00")
    assert signed_checked_cell.is_corrected is True
    assert signed_checked_totals[item.id] == Decimal("12.00")


def test_measurement_pdf_does_not_add_extra_customer_signature_notice_when_unsigned():
    from io import BytesIO

    from pypdf import PdfReader

    from app.services.measurement_pdf_service import MeasurementPdfService

    db = db_session()
    site = create_site(db)
    base = create_measurement_base(db, site)
    item = SiteMeasurementItem(
        site=site,
        measurement_base=base,
        position="1.01.05.10",
        description="Kabelrinne liefern und montieren",
        list_quantity=Decimal("0.00"),
        unit="m",
        minutes_per_unit=Decimal("19.80"),
        list_minutes_total=Decimal("0.00"),
        is_nep=False,
        sort_order=1,
    )
    batch = SiteMeasurementBatch(
        site=site,
        measurement_base=base,
        number=1,
        title="Aufmaß 1",
        status="reviewed",
    )
    entry = SiteMeasurementEntry(
        measurement_batch=batch,
        measurement_item=item,
        site=site,
        quantity=Decimal("12.00"),
        area_or_comment="EG",
        status="submitted",
    )
    db.add_all([item, batch, entry])
    db.commit()

    pdf_content, _filename = MeasurementPdfService(db).build_batch_pdf(
        site_id=site.id,
        batch_id=batch.id,
        mode="checked",
    )
    pdf_text = "\n".join(page.extract_text() or "" for page in PdfReader(BytesIO(pdf_content)).pages)

    assert "Name Auftraggeber (Kunde):" in pdf_text
    assert "Unterschrift Kunde / Auftraggeber" not in pdf_text


def test_site_measurement_batches_include_customer_email_status():
    db = db_session()
    site = create_site(db)
    base = create_measurement_base(db, site)
    batch = SiteMeasurementBatch(
        site=site,
        measurement_base=base,
        number=1,
        title="Aufmaß 1",
        status="reviewed",
    )
    db.add(batch)
    db.commit()
    db.add(
        AuditLog(
            user_id=None,
            action="measurement.email_sent",
            entity_type="measurement_batch",
            entity_id=batch.id,
            old_value_json=None,
            new_value_json={
                "recipients": ["kunde@example.de"],
                "customer_signature_present": False,
            },
        )
    )
    db.commit()

    [read_batch] = MeasurementService(db).list_site_batches(site.id)

    assert read_batch.customer_email_sent_at is not None
    assert read_batch.customer_email_signature_present is False


def test_site_measurement_batch_delete_archives_and_restore_reactivates():
    db = db_session()
    site = create_site(db)
    base = create_measurement_base(db, site)
    user = User(username="office", display_name="Büro", password_hash="x", role=UserRole.OFFICE)
    batch = SiteMeasurementBatch(
        site=site,
        measurement_base=base,
        number=1,
        title="Aufmaß 1",
        status="reviewed",
        submitted_by=user,
        submitted_at=datetime(2026, 7, 8, 8, 0, tzinfo=timezone.utc),
    )
    db.add_all([user, batch])
    db.commit()

    service = MeasurementService(db)
    service.delete_site_batch(site_id=site.id, batch_id=batch.id, current_user=user)

    stored_batch = db.get(SiteMeasurementBatch, batch.id)
    assert stored_batch is not None
    assert stored_batch.deleted_at is not None
    assert stored_batch.deleted_by_user_id == user.id
    assert service.list_site_batches(site.id) == []
    [archived_batch] = service.list_site_batches(site.id, archived_only=True)
    assert archived_batch.id == batch.id
    assert archived_batch.status == "reviewed"
    assert archived_batch.deleted_at is not None
    assert archived_batch.deleted_by_user_id == user.id
    assert archived_batch.deleted_by_name == "Büro"

    restored_batch = service.restore_site_batch(site_id=site.id, batch_id=batch.id)

    assert restored_batch.id == batch.id
    assert restored_batch.deleted_at is None
    assert restored_batch.deleted_by_user_id is None
    assert [active_batch.id for active_batch in service.list_site_batches(site.id)] == [batch.id]
    assert service.list_site_batches(site.id, archived_only=True) == []


def test_office_measurement_batch_uses_existing_model_and_is_idempotent():
    db = db_session()
    site = create_site(db)
    base = create_measurement_base(db, site)
    office_user = User(
        username="office-create",
        display_name="Büro",
        password_hash="x",
        role=UserRole.OFFICE,
    )
    worker = Person(
        first_name="Anna",
        last_name="Zimmer",
        display_name="Anna Zimmer",
        short_code="AZ",
        person_type=PersonType.INTERNAL,
        is_active=True,
        employment_status=PersonEmploymentStatus.ACTIVE.value,
    )
    worker_user = User(
        username="worker-create",
        display_name="Anna Zimmer",
        password_hash="x",
        role=UserRole.MONTEUR,
        person=worker,
        is_active=True,
    )
    db.add_all([office_user, worker_user])
    db.commit()
    payload = OfficeMeasurementBatchCreate(
        area_location="  1.   Obergeschoss ",
        measurement_date=date(2026, 7, 16),
        assigned_employee_id=worker.id,
        offer_id=base.id,
        request_id="office-measurement-request-1",
    )

    service = MeasurementService(db)
    created = service.create_office_batch(
        site_id=site.id,
        current_user=office_user,
        payload=payload,
    )
    retried = service.create_office_batch(
        site_id=site.id,
        current_user=office_user,
        payload=payload,
    )

    assert retried.id == created.id
    assert created.status == "draft"
    assert created.origin == MeasurementBatchOrigin.OFFICE
    assert created.position_mode == MeasurementPositionMode.BLANK
    assert created.measurement_base_id is None
    assert created.offer_id is None
    assert created.creator_role_at_creation == UserRole.OFFICE.value
    assert created.area_location == "1. Obergeschoss"
    assert created.measurement_date == date(2026, 7, 16)
    assert created.assigned_employee_id == worker.id
    assert created.assigned_employee_name == "Anna Zimmer"
    assert created.submitted_by_user_id is None
    assert created.submitted_at is None
    assert created.has_original_worker_submission is False
    assert created.area_rows == []
    assert service.list_site_batch_items(site_id=site.id, batch_id=created.id) == []
    assert db.scalar(select(func.count(SiteMeasurementBatch.id))) == 1


def test_office_measurement_batch_requires_explicit_duplicate_confirmation():
    db = db_session()
    site = create_site(db)
    base = create_measurement_base(db, site)
    office_user = User(
        username="office-duplicate",
        display_name="Büro",
        password_hash="x",
        role=UserRole.OFFICE,
    )
    db.add(office_user)
    db.commit()
    service = MeasurementService(db)
    first_payload = OfficeMeasurementBatchCreate(
        area_location="Technikzentrale",
        measurement_date=date(2026, 7, 16),
        offer_id=base.id,
        request_id="office-measurement-request-2a",
    )
    service.create_office_batch(site_id=site.id, current_user=office_user, payload=first_payload)

    second_payload = first_payload.model_copy(
        update={"request_id": "office-measurement-request-2b"}
    )
    with pytest.raises(HTTPException) as error:
        service.create_office_batch(
            site_id=site.id,
            current_user=office_user,
            payload=second_payload,
        )
    assert error.value.status_code == 409

    confirmed = service.create_office_batch(
        site_id=site.id,
        current_user=office_user,
        payload=second_payload.model_copy(update={"allow_duplicate": True}),
    )
    assert confirmed.id is not None
    assert db.scalar(select(func.count(SiteMeasurementBatch.id))) == 2


def test_office_measurement_batch_stays_blank_when_several_offers_exist():
    db = db_session()
    site = create_site(db)
    first_base = create_measurement_base(db, site)
    second_base = SiteMeasurementBase(
        site=site,
        name="Nachtragsangebot",
        status="draft",
        released_to_mobile=False,
    )
    office_user = User(
        username="office-offer",
        display_name="Büro",
        password_hash="x",
        role=UserRole.OFFICE,
    )
    db.add_all([second_base, office_user])
    db.commit()
    service = MeasurementService(db)
    payload = OfficeMeasurementBatchCreate(
        area_location="Bauteil A",
        measurement_date=date(2026, 7, 16),
        request_id="office-measurement-request-3",
    )

    created = service.create_office_batch(
        site_id=site.id,
        current_user=office_user,
        payload=payload,
    )
    assert created.position_mode == MeasurementPositionMode.BLANK
    assert created.offer_id is None
    assert created.offer_id != first_base.id
    assert created.offer_id != second_base.id
    assert created.is_current_offer is False


def test_office_measurement_worker_options_only_contain_active_internal_monteurs():
    db = db_session()
    site = create_site(db)

    def add_person(
        first_name: str,
        last_name: str,
        *,
        role: UserRole = UserRole.MONTEUR,
        person_type: PersonType = PersonType.INTERNAL,
        active: bool = True,
    ) -> Person:
        person = Person(
            first_name=first_name,
            last_name=last_name,
            display_name=f"{first_name} {last_name}",
            short_code=f"{first_name[0]}{last_name[0]}",
            person_type=person_type,
            is_active=active,
            employment_status=(
                PersonEmploymentStatus.ACTIVE.value
                if active
                else PersonEmploymentStatus.DEPARTED.value
            ),
        )
        db.add(
            User(
                username=f"{first_name}-{last_name}-{role.value}",
                display_name=person.display_name,
                password_hash="x",
                role=role,
                person=person,
                is_active=active,
            )
        )
        return person

    anna = add_person("Anna", "Zimmer")
    bernd = add_person("Bernd", "Albers")
    add_person("Clara", "Extern", person_type=PersonType.EXTERNAL)
    add_person("Dora", "Inaktiv", active=False)
    add_person("Erik", "Leitung", role=UserRole.PROJECT_MANAGER)
    db.commit()

    workers = MeasurementService(db).list_office_measurement_workers(site.id)

    assert [person.id for person in workers] == [bernd.id, anna.id]


def test_office_measurement_draft_is_editable_but_not_visible_in_mobile_batches():
    from app.models.assignment import Assignment
    from app.schemas.measurement import MeasurementEntryCreate

    db = db_session()
    site = create_site(db)
    base = create_measurement_base(db, site)
    worker = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
        person_type=PersonType.INTERNAL,
        is_active=True,
        employment_status=PersonEmploymentStatus.ACTIVE.value,
    )
    worker_user = User(
        username="mobile-worker",
        display_name=worker.display_name,
        password_hash="x",
        role=UserRole.MONTEUR,
        person=worker,
    )
    office_user = User(
        username="office-mobile-visibility",
        display_name="Büro",
        password_hash="x",
        role=UserRole.OFFICE,
    )
    assignment = Assignment(
        site=site,
        person=worker,
        start_date=date(2026, 7, 16),
        end_date=date(2026, 7, 16),
    )
    item = SiteMeasurementItem(
        site=site,
        measurement_base=base,
        position="1.1",
        description="Leistung",
        unit="Stck",
        sort_order=10,
    )
    db.add_all([worker_user, office_user, assignment, item])
    db.commit()
    service = MeasurementService(db)
    mobile_batch = service.create_mobile_batch(
        assignment_id=assignment.id,
        current_user=worker_user,
    )
    office_batch = service.create_office_batch(
        site_id=site.id,
        current_user=office_user,
        payload=OfficeMeasurementBatchCreate(
            area_location="Flur West",
            measurement_date=date(2026, 7, 16),
            offer_id=base.id,
            request_id="office-measurement-request-4",
        ),
    )

    free_item = service.create_site_free_item(
        site_id=site.id,
        batch_id=office_batch.id,
        current_user=office_user,
        payload=MobileMeasurementFreeItemCreate(
            description="Leistung",
            unit="st",
        ),
    )
    created_entry = service.create_site_entry(
        site_id=site.id,
        batch_id=office_batch.id,
        measurement_item_id=free_item.id,
        current_user=office_user,
        payload=MeasurementEntryCreate(area_or_comment="Flur West", quantity=Decimal("2")),
    )
    mobile_batches = service.list_mobile_batches(
        assignment_id=assignment.id,
        current_user=worker_user,
    )

    assert created_entry.quantity == Decimal("2")
    assert [batch.id for batch in mobile_batches] == [mobile_batch.id]


def test_office_measurement_has_no_original_worker_pdf():
    from app.services.measurement_pdf_service import MeasurementPdfService

    db = db_session()
    site = create_site(db)
    base = create_measurement_base(db, site)
    office_user = User(
        username="office-pdf",
        display_name="Büro",
        password_hash="x",
        role=UserRole.OFFICE,
    )
    db.add(office_user)
    db.commit()
    created = MeasurementService(db).create_office_batch(
        site_id=site.id,
        current_user=office_user,
        payload=OfficeMeasurementBatchCreate(
            area_location="Technikzentrale",
            measurement_date=date(2026, 7, 16),
            offer_id=base.id,
            request_id="office-measurement-request-5",
        ),
    )

    with pytest.raises(HTTPException) as error:
        MeasurementPdfService(db).build_batch_pdf(
            site_id=site.id,
            batch_id=created.id,
            mode="original",
        )

    assert error.value.status_code == 409
    assert error.value.detail == "Kein originales Monteur-Aufmaß vorhanden."


def test_blank_office_measurement_manages_only_its_free_positions():
    from io import BytesIO

    from pypdf import PdfReader

    from app.schemas.measurement import MeasurementEntryCreate, MeasurementItemUpdate
    from app.services.measurement_pdf_service import MeasurementPdfService

    db = db_session()
    site = create_site(db)
    base = create_measurement_base(db, site)
    offer_item = SiteMeasurementItem(
        site=site,
        measurement_base=base,
        position="1.1",
        description="Angebotsposition",
        unit="st",
        sort_order=10,
    )
    office_user = User(
        username="office-blank-items",
        display_name="Büro",
        password_hash="x",
        role=UserRole.OFFICE,
    )
    db.add_all([offer_item, office_user])
    db.commit()
    service = MeasurementService(db)
    batch = service.create_office_batch(
        site_id=site.id,
        current_user=office_user,
        payload=OfficeMeasurementBatchCreate(
            area_location="Technikraum",
            measurement_date=date(2026, 7, 16),
            request_id="office-blank-position-request",
        ),
    )

    assert service.list_site_batch_items(site_id=site.id, batch_id=batch.id) == []
    free_item = service.create_site_free_item(
        site_id=site.id,
        batch_id=batch.id,
        current_user=office_user,
        payload=MobileMeasurementFreeItemCreate(
            position="A-1",
            description="Freie Leistung",
            unit="m",
        ),
    )
    assert free_item.measurement_base_id is None
    assert free_item.position == "A-1"

    second_item = service.create_site_free_item(
        site_id=site.id,
        batch_id=batch.id,
        current_user=office_user,
        payload=MobileMeasurementFreeItemCreate(
            position="B-1",
            description="Zweite freie Leistung",
            unit="st",
            quantity=Decimal("3"),
            area_or_comment="Technikraum",
        ),
    )
    assert second_item.id != free_item.id
    assert (free_item.sort_order, second_item.sort_order) == (1, 2)

    updated = service.update_site_free_item(
        site_id=site.id,
        batch_id=batch.id,
        measurement_item_id=free_item.id,
        payload=MeasurementItemUpdate(
            position="A-2",
            description="Geänderte freie Leistung",
            unit="psch",
        ),
    )
    assert updated.position == "A-2"
    assert updated.description == "Geänderte freie Leistung"
    assert updated.unit == "psch"
    assert [item.id for item in service.list_site_batch_items(site_id=site.id, batch_id=batch.id)] == [
        free_item.id,
        second_item.id,
    ]

    service.create_site_entry(
        site_id=site.id,
        batch_id=batch.id,
        measurement_item_id=free_item.id,
        current_user=office_user,
        payload=MeasurementEntryCreate(area_or_comment="Technikraum", quantity=Decimal("2.5")),
    )
    reviewed = service.set_site_batch_reviewed(site_id=site.id, batch_id=batch.id)
    assert reviewed.status == "reviewed"
    stored_batch = service._get_batch_for_site(batch.id, site.id)
    positions, areas, _cells, _totals = MeasurementPdfService(db)._build_matrix(
        stored_batch,
        mode="checked",
    )
    assert [position.description for position in positions] == [
        "Geänderte freie Leistung",
        "Zweite freie Leistung",
    ]
    assert [position.position for position in positions] == ["A-2", "B-1"]
    assert [area.label for area in areas] == ["Technikraum"]
    pdf_content, filename = MeasurementPdfService(db).build_batch_pdf(
        site_id=site.id,
        batch_id=batch.id,
        mode="checked",
    )
    assert pdf_content.startswith(b"%PDF")
    assert filename.endswith(".pdf")
    pdf_text = "\n".join(page.extract_text() or "" for page in PdfReader(BytesIO(pdf_content)).pages)
    assert "Aufmaß" in pdf_text
    assert "Kunde:" in pdf_text
    assert "Komissions-Nr.:" in pdf_text
    assert "Projekt/Bauvorhaben:" in pdf_text
    assert "Blatt-Nr.:" in pdf_text
    assert "Datum:" in pdf_text
    assert "Adresse:" not in pdf_text
    assert "Monteur:" not in pdf_text
    assert "Eingereicht:" not in pdf_text
    assert "Herkunft:" not in pdf_text
    assert "Status:" not in pdf_text
    assert b"1 0 0 1 0 32 cm" in pdf_content

    service.delete_site_free_item(
        site_id=site.id,
        batch_id=batch.id,
        measurement_item_id=free_item.id,
    )
    remaining = service.list_site_batch_items(site_id=site.id, batch_id=batch.id)
    assert [item.id for item in remaining] == [second_item.id]
    assert remaining[0].position == "B-1"
    assert db.scalar(
        select(func.count(SiteMeasurementEntry.id)).where(
            SiteMeasurementEntry.measurement_item_id == free_item.id
        )
    ) == 0


def test_blank_office_measurement_uses_the_standard_completion_workflow():
    db = db_session()
    site = create_site(db)
    office_user = User(
        username="office-blank-validation",
        display_name="Büro",
        password_hash="x",
        role=UserRole.OFFICE,
    )
    db.add(office_user)
    db.commit()
    service = MeasurementService(db)
    batch = service.create_office_batch(
        site_id=site.id,
        current_user=office_user,
        payload=OfficeMeasurementBatchCreate(
            area_location="Flur",
            measurement_date=date(2026, 7, 16),
            request_id="office-blank-validation-request",
        ),
    )

    reviewed = service.set_site_batch_reviewed(site_id=site.id, batch_id=batch.id)
    assert reviewed.status == "reviewed"
    billed = service.set_site_batch_billing_status(
        site_id=site.id,
        batch_id=batch.id,
        billing_status="billed",
    )
    assert billed.status == "billed"
    assert service.list_site_batch_items(site_id=site.id, batch_id=batch.id) == []


def test_blank_office_position_is_persisted_from_its_first_header_value():
    db = db_session()
    site = create_site(db)
    office_user = User(
        username="office-first-position-value",
        display_name="Büro",
        password_hash="x",
        role=UserRole.OFFICE,
    )
    db.add(office_user)
    db.commit()
    service = MeasurementService(db)
    batch = service.create_office_batch(
        site_id=site.id,
        current_user=office_user,
        payload=OfficeMeasurementBatchCreate(
            area_location="Flur",
            measurement_date=date(2026, 7, 16),
            request_id="office-first-position-value-request",
        ),
    )

    created = service.create_site_free_item(
        site_id=site.id,
        batch_id=batch.id,
        current_user=office_user,
        payload=MobileMeasurementFreeItemCreate(position="1.01.20", description="", unit=""),
    )

    assert created.id is not None
    assert created.position == "1.01.20"
    assert created.description == ""
    assert created.unit == ""
    reloaded = service.list_site_batch_items(site_id=site.id, batch_id=batch.id)
    assert [item.id for item in reloaded] == [created.id]
