from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.models import Base
from app.models.customer import Customer, CustomerContact
from app.models.site import Site
from app.models.site_email_recipient import SiteEmailRecipient
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
