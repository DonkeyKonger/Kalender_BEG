from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.services.customer_service import clean_customer_contacts, clean_customer_values, customer_snapshot


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
