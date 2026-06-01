from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.customer import Customer, CustomerContact
from app.repositories.customer_repository import CustomerRepository
from app.schemas.customer import CustomerCreate, CustomerUpdate
from app.services.audit_service import AuditService


OPTIONAL_CUSTOMER_TEXT_FIELDS = [
    "company_name",
    "address_street",
    "address_house_number",
    "address_postal_code",
    "address_city",
    "address_country",
    "company_phone",
    "project_lead_name",
    "project_lead_phone",
    "project_lead_email",
]
CONTACT_TEXT_FIELDS = ["contact_type", "name", "phone", "email"]


class CustomerService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.customers = CustomerRepository(db)
        self.audit = AuditService(db)

    def list_customers(self, is_active: bool | None = None) -> list[Customer]:
        return self.customers.list(is_active=is_active)

    def create_customer(self, payload: CustomerCreate, user_id: int) -> Customer:
        values = clean_customer_values(payload.model_dump())
        contact_values = values.pop("contacts", [])
        customer = Customer(**values)
        customer.contacts = [CustomerContact(**contact) for contact in contact_values]
        self.customers.add(customer)
        self.db.flush()
        self.audit.record(
            user_id=user_id,
            action="customer.created",
            entity_type="customer",
            entity_id=customer.id,
            old_value=None,
            new_value=customer_snapshot(customer),
        )
        self.db.commit()
        self.db.refresh(customer)
        return self.customers.get(customer.id) or customer

    def update_customer(self, customer_id: int, payload: CustomerUpdate, user_id: int) -> Customer:
        customer = self.customers.get(customer_id)
        if customer is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Kunde nicht gefunden.")

        values = clean_customer_values(payload.model_dump(exclude_unset=True), partial=True)
        contact_values = values.pop("contacts", None)
        old_value = customer_snapshot(customer)

        for field, value in values.items():
            setattr(customer, field, value)
        if contact_values is not None:
            customer.contacts = [CustomerContact(**contact) for contact in contact_values]

        self.audit.record(
            user_id=user_id,
            action="customer.updated",
            entity_type="customer",
            entity_id=customer.id,
            old_value=old_value,
            new_value=customer_snapshot(customer),
        )
        self.db.commit()
        self.db.refresh(customer)
        return self.customers.get(customer.id) or customer

    def remove_customer(self, customer_id: int, user_id: int) -> Customer:
        customer = self.customers.get(customer_id)
        if customer is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Kunde nicht gefunden.")
        if not customer.is_active:
            return customer

        old_value = customer_snapshot(customer)
        customer.is_active = False
        self.audit.record(
            user_id=user_id,
            action="customer.deactivated",
            entity_type="customer",
            entity_id=customer.id,
            old_value=old_value,
            new_value=customer_snapshot(customer),
        )
        self.db.commit()
        self.db.refresh(customer)
        return self.customers.get(customer.id) or customer


def clean_customer_values(values: dict, *, partial: bool = False) -> dict:
    cleaned = dict(values)
    for field in OPTIONAL_CUSTOMER_TEXT_FIELDS:
        if isinstance(cleaned.get(field), str):
            cleaned[field] = cleaned[field].strip() or None
    if "address_country" in cleaned and not cleaned.get("address_country"):
        cleaned["address_country"] = "Deutschland"
    if not partial and not cleaned.get("company_name"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Firmenname darf nicht leer sein.")
    if "company_name" in cleaned and not cleaned.get("company_name"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Firmenname darf nicht leer sein.")
    validate_email(cleaned.get("project_lead_email"), "Projektleiter-Mail")
    if "contacts" in cleaned:
        cleaned["contacts"] = clean_customer_contacts(cleaned.get("contacts") or [])
    return cleaned


def clean_customer_contacts(contacts: list[dict]) -> list[dict]:
    cleaned_contacts: list[dict] = []
    for raw_contact in contacts:
        contact = dict(raw_contact)
        for field in CONTACT_TEXT_FIELDS:
            if isinstance(contact.get(field), str):
                contact[field] = contact[field].strip() or None
        if not any(contact.get(field) for field in ("name", "phone", "email")):
            continue
        if not contact.get("name"):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Ansprechpartner-Name darf nicht leer sein.")
        contact["contact_type"] = contact.get("contact_type") or "monteur"
        validate_email(contact.get("email"), "Ansprechpartner-Mail")
        cleaned_contacts.append(
            {
                "contact_type": contact["contact_type"],
                "name": contact["name"],
                "phone": contact.get("phone"),
                "email": contact.get("email"),
            }
        )
    return cleaned_contacts


def validate_email(value: str | None, label: str) -> None:
    if value and "@" not in value:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{label} ist nicht gueltig.")


def customer_snapshot(customer: Customer) -> dict:
    return {
        "id": customer.id,
        "company_name": customer.company_name,
        "address_street": customer.address_street,
        "address_house_number": customer.address_house_number,
        "address_postal_code": customer.address_postal_code,
        "address_city": customer.address_city,
        "address_country": customer.address_country,
        "company_phone": customer.company_phone,
        "project_lead_name": customer.project_lead_name,
        "project_lead_phone": customer.project_lead_phone,
        "project_lead_email": customer.project_lead_email,
        "is_active": customer.is_active,
        "contacts": [
            {
                "id": contact.id,
                "contact_type": contact.contact_type,
                "name": contact.name,
                "phone": contact.phone,
                "email": contact.email,
            }
            for contact in customer.contacts
        ],
    }
