from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.models import Base
from app.models.customer import Customer, CustomerContact, CustomerEmailLabel
from app.models.enums import SiteLocationStatus
from app.models.site import Site
from app.models.site_email_recipient import SiteEmailRecipient
from app.schemas.customer import CustomerCreate, CustomerUpdate
from app.services.customer_service import CustomerService, clean_customer_contacts, clean_customer_values, customer_snapshot


def db_session() -> Session:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return Session(engine)


def test_clean_customer_values_trims_required_company_name_and_defaults_country():
    values = clean_customer_values(
        {
            "company_name": "  EBM GmbH  ",
            "address_country": " ",
            "project_lead_email": "leitung@example.com",
            "contacts": [],
        }
    )

    assert values["company_name"] == "EBM GmbH"
    assert values["address_country"] == "Deutschland"


def test_clean_customer_values_rejects_blank_company_name():
    with pytest.raises(HTTPException) as error:
        clean_customer_values({"company_name": "   ", "contacts": []})

    assert error.value.status_code == 400


def test_clean_customer_contacts_filters_empty_rows_and_keeps_customer_contacts():
    contacts = clean_customer_contacts(
        [
            {"contact_type": "monteur", "name": " ", "phone": " ", "email": " "},
            {"contact_type": "monteur", "name": "  Max Kunde  ", "phone": " 0541 ", "email": " max@example.com "},
        ]
    )

    assert contacts == [
        {
            "contact_type": "monteur",
            "name": "Max Kunde",
            "phone": "0541",
            "email": "max@example.com",
        }
    ]


def test_clean_customer_contacts_rejects_invalid_contact_email():
    with pytest.raises(HTTPException) as error:
        clean_customer_contacts([{"contact_type": "monteur", "name": "Max Kunde", "email": "ungueltig"}])

    assert error.value.status_code == 400


def test_customer_snapshot_contains_contacts_without_person_reference():
    customer = SimpleNamespace(
        id=1,
        company_name="EBM GmbH",
        address_street=None,
        address_house_number=None,
        address_postal_code=None,
        address_city="Osnabrueck",
        address_country="Deutschland",
        company_phone=None,
        project_lead_name=None,
        project_lead_phone=None,
        project_lead_email=None,
        is_active=True,
        contacts=[
            SimpleNamespace(id=2, contact_type="monteur", name="Max Kunde", phone=None, email=None),
        ],
    )

    assert customer_snapshot(customer)["contacts"] == [
        {
            "id": 2,
            "contact_type": "monteur",
            "name": "Max Kunde",
            "phone": None,
            "email": None,
        }
    ]


def test_customer_read_includes_site_email_recipients_without_duplicates():
    db = db_session()
    customer = Customer(
        company_name="Klinik GmbH",
        project_lead_name="Leitung",
        project_lead_email="Info@Klinik.example",
        is_active=True,
    )
    customer.contacts = [
        CustomerContact(contact_type="mobile_email", name="Mobile E-Mail", email="info@klinik.example"),
    ]
    site = Site(site_number="8007", name="Schüchtermann Klinik", customer=" klinik   gmbh ")
    other_site = Site(site_number="9999", name="Andere Baustelle", customer="Andere GmbH")
    db.add_all([customer, site, other_site])
    db.flush()
    db.add_all([
        SiteEmailRecipient(site_id=site.id, email="NEU@KLINIK.example", label="Neue Adresse", source="manual"),
        SiteEmailRecipient(site_id=site.id, email="info@klinik.example", label="Doppelt", source="manual"),
        SiteEmailRecipient(site_id=other_site.id, email="andere@example.de", label="Andere", source="manual"),
    ])
    db.commit()

    read_customer = CustomerService(db).read_customer(customer)

    assert [item.email for item in read_customer.email_addresses] == ["Info@Klinik.example", "NEU@KLINIK.example"]


def test_customer_email_labels_override_raw_suggestion_labels():
    db = db_session()
    customer = Customer(company_name="Klinik GmbH", is_active=True)
    site = Site(site_number="8007", name="Schüchtermann Klinik", customer="Klinik GmbH")
    db.add_all([customer, site])
    db.flush()
    db.add(SiteEmailRecipient(site_id=site.id, email="info@klinik.example", label="Mobile E-Mail", source="manual"))
    db.add(
        CustomerEmailLabel(
            customer_id=customer.id,
            email="info@klinik.example",
            email_normalized="info@klinik.example",
            label="Sekretariat",
        )
    )
    db.commit()

    read_customer = CustomerService(db).read_customer(customer)

    assert [(item.email, item.label) for item in read_customer.email_addresses] == [
        ("info@klinik.example", "Sekretariat"),
    ]


def test_update_customer_persists_empty_email_label_override():
    db = db_session()
    service = CustomerService(db)
    customer = Customer(company_name="Klinik GmbH", is_active=True)
    customer.contacts = [
        CustomerContact(contact_type="monteur", name="Manuel Wüller", email="manuel@example.de"),
    ]
    db.add(customer)
    db.commit()

    service.update_customer(
        customer.id,
        CustomerUpdate(email_addresses=[{"email": "manuel@example.de", "label": ""}]),
        user_id=7,
    )
    read_customer = service.read_customer(customer)

    assert [(item.email, item.label) for item in read_customer.email_addresses] == [
        ("manuel@example.de", ""),
    ]


def test_create_customer_keeps_selected_address_geocode():
    db = db_session()
    service = CustomerService(db)

    customer = service.create_customer(
        CustomerCreate(
            company_name="Geocode GmbH",
            address_street="Moorburger Str.",
            address_house_number="16",
            address_postal_code="21079",
            address_city="Hamburg",
            address_country="Deutschland",
            address_formatted="Moorburger Str. 16, 21079 Hamburg",
            address_latitude=53.456,
            address_longitude=9.987,
            address_location_status=SiteLocationStatus.GEOCODED,
            contacts=[],
        ),
        user_id=7,
    )

    assert customer.address_formatted == "Moorburger Str. 16, 21079 Hamburg"
    assert customer.address_latitude == 53.456
    assert customer.address_longitude == 9.987
    assert customer.address_location_status == SiteLocationStatus.GEOCODED


def test_update_customer_clears_coordinates_when_address_changes_without_selected_geocode():
    db = db_session()
    service = CustomerService(db)
    customer = Customer(
        company_name="Alt GmbH",
        address_street="Altstrasse",
        address_house_number="1",
        address_postal_code="11111",
        address_city="Altstadt",
        address_formatted="Altstrasse 1, 11111 Altstadt",
        address_latitude=53.456,
        address_longitude=9.987,
        address_location_status=SiteLocationStatus.GEOCODED,
        is_active=True,
    )
    db.add(customer)
    db.commit()

    updated = service.update_customer(
        customer.id,
        CustomerUpdate(address_city="Neustadt"),
        user_id=7,
    )

    assert updated.address_city == "Neustadt"
    assert updated.address_formatted is None
    assert updated.address_latitude is None
    assert updated.address_longitude is None
    assert updated.address_location_status == SiteLocationStatus.UNCHECKED


def test_remove_customer_sets_tombstone_and_hides_from_normal_queries():
    db = db_session()
    service = CustomerService(db)
    customer = Customer(company_name="Tombstone GmbH", is_active=True)
    db.add(customer)
    db.commit()

    removed = service.remove_customer(customer.id, user_id=42)

    assert removed.is_active is False
    assert removed.deleted_at is not None
    assert removed.deleted_by == 42
    assert removed.deleted_tombstone_id.startswith(f"deleted::{customer.id}::")
    assert service.customers.get(customer.id) is None
    assert service.list_customers(is_active=None) == []
    assert service.list_customers(is_active=False) == []
    assert service.customers.get_including_deleted(customer.id) is not None


def test_removed_customer_name_can_be_reused():
    db = db_session()
    service = CustomerService(db)
    original = Customer(company_name="Wiederverwendbar GmbH", is_active=True)
    db.add(original)
    db.commit()

    service.remove_customer(original.id, user_id=7)
    recreated = service.create_customer(
        CustomerCreate(company_name="Wiederverwendbar GmbH", contacts=[]),
        user_id=7,
    )

    assert recreated.id != original.id
    assert recreated.company_name == "Wiederverwendbar GmbH"
    assert recreated.deleted_at is None
    assert [customer.id for customer in service.list_customers()] == [recreated.id]
