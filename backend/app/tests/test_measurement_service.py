from datetime import date, datetime, timezone
from decimal import Decimal

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models import Base
from app.models.enums import SiteLocationStatus, SiteStatus
from app.models.site import Site
from app.models.site_measurement_item import (
    SiteMeasurementBase,
    SiteMeasurementBatch,
    SiteMeasurementBatchPhoto,
    SiteMeasurementEntry,
    SiteMeasurementItem,
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
            quantity=Decimal("2.00"),
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
    assert item.reported_quantity == Decimal("2.00")
    assert stored_entry is not None
    assert stored_entry.measurement_batch_id == batch.id
    assert stored_entry.area_or_comment == "2. OG"
    assert stored_entry.quantity == Decimal("2.00")


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
    entry = service.create_mobile_entry(
        assignment_id=assignment.id,
        batch_id=batch.id,
        measurement_item_id=item.id,
        current_user=user,
        payload=MeasurementEntryCreate(area_or_comment="1. OG Flur", quantity=Decimal("10.00")),
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
    assert stored_item is not None
    assert stored_item.list_quantity == Decimal("0.00")
    assert stored_batch is not None
    assert stored_batch.title == "Aufmaß 1"
    assert stored_batch.status == "draft"
    assert stored_entry is not None
    assert stored_entry.measurement_batch_id == batch.id
    assert stored_entry.area_or_comment == "1. OG Flur"
    assert mobile_items[0].reported_quantity == Decimal("10.00")
    assert mobile_items[0].reported_minutes == Decimal("198.0000")
    assert mobile_items[0].mobile_status == "edited"
    assert mobile_batches[0].entry_count == 1
    assert mobile_batches[0].position_count == 1
    assert mobile_batches[0].reported_minutes == Decimal("198.0000")


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
        payload=MeasurementEntryCreate(area_or_comment="1. OG Flur", quantity=Decimal("10.00")),
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
            payload=MeasurementEntryCreate(area_or_comment="2. OG", quantity=Decimal("5.00")),
        )
    assert locked.value.status_code == 409


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
    with pytest.raises(HTTPException) as draft_review:
        service.set_site_batch_billing_status(site_id=site.id, batch_id=batch.id, billing_status="billed")
    assert draft_review.value.status_code == 409

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
    with pytest.raises(HTTPException) as submitted_billing:
        service.set_site_batch_billing_status(
            site_id=site.id,
            batch_id=submitted.id,
            billing_status="billed",
        )
    assert submitted_billing.value.status_code == 409
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

    db.add_all(
        [
            ticket(1, datetime(2026, 8, 12, 12, 0, tzinfo=timezone.utc), 3),
            ticket(2, datetime(2026, 8, 17, 12, 0, tzinfo=timezone.utc), 4),
            ticket(3, datetime(2026, 9, 14, 12, 0, tzinfo=timezone.utc), 5),
            ticket(4, datetime(2026, 9, 21, 12, 0, tzinfo=timezone.utc), 6),
        ]
    )
    db.commit()

    analysis = MeasurementService(db).get_site_measurement_time_analysis(site.id)

    assert [row.actual_minutes for row in analysis.rows] == [
        Decimal("2400"),
        Decimal("1200"),
        Decimal("8100"),
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
    db.add_all([person, user, ticket])
    db.commit()

    service = MeasurementService(db)
    dashboard_messages = service.list_dashboard_submissions(limit=5)

    assert len(dashboard_messages) == 1
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

    assert dashboard_messages[0].batch_id == batch.id
    assert dashboard_messages[0].message_type == "measurement_customer_signed"
    assert dashboard_messages[0].event_at == signed.customer_signed_at
    assert dashboard_messages[0].customer_signature_name == "Kunde Beispiel"
    assert dashboard_messages[0].submitted_by_name is None
    assert dashboard_messages[0].message_key == f"measurement_customer_signed:{batch.id}"
    assert signed.customer_signature_place == "Klinikweg 8, 77815 Buehl"

    service.dismiss_dashboard_message(message_key=dashboard_messages[0].message_key, current_user=user)
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


def test_measurement_pdf_marks_empty_customer_signature_field():
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

    assert "Unterschrift Kunde / Auftraggeber" in pdf_text
    assert "Ort / Datum" in pdf_text
