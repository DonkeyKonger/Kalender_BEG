from datetime import datetime, timezone

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.customer import Customer, CustomerContact, CustomerEmailLabel
from app.models.enums import SiteLocationStatus
from app.models.site import Site
from app.models.site_email_recipient import SiteEmailRecipient
from app.repositories.customer_repository import CustomerRepository
from app.schemas.customer import CustomerCreate, CustomerEmailAddressRead, CustomerRead, CustomerUpdate
from app.services.audit_service import AuditService
from app.services.geo_service import has_valid_coordinates


OPTIONAL_CUSTOMER_TEXT_FIELDS = [
    "company_name",
    "address_street",
    "address_house_number",
    "address_postal_code",
    "address_city",
    "address_country",
    "address_extra",
    "address_formatted",
    "company_phone",
    "project_lead_name",
    "project_lead_phone",
    "project_lead_email",
]
ADDRESS_FIELDS = {
    "address_street",
    "address_house_number",
    "address_postal_code",
    "address_city",
    "address_country",
    "address_extra",
    "address_formatted",
}
TECHNICAL_LOCATION_FIELDS = {"address_latitude", "address_longitude", "address_location_status"}
CONTACT_TEXT_FIELDS = ["contact_type", "name", "phone", "email"]


class CustomerService:
    def __init__(self, db: Session) -> None:
        self.db = db
        self.customers = CustomerRepository(db)
        self.audit = AuditService(db)

    def list_customers(self, is_active: bool | None = None) -> list[Customer]:
        return self.customers.list(is_active=is_active)

    def read_customer(self, customer: Customer) -> CustomerRead:
        return CustomerRead.model_validate(customer).model_copy(
            update={"email_addresses": customer_email_addresses(customer, self.db)}
        )

    def create_customer(self, payload: CustomerCreate, user_id: int) -> Customer:
        values = clean_customer_values(payload.model_dump())
        apply_selected_customer_geocode(values)
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
        email_label_values = values.pop("email_addresses", None)
        old_value = customer_snapshot(customer)
        address_changed = any(
            field in values and getattr(customer, field) != values[field]
            for field in ADDRESS_FIELDS
        )
        selected_geocode = apply_selected_customer_geocode(values)

        for field, value in values.items():
            setattr(customer, field, value)
        if address_changed and not selected_geocode:
            customer.address_formatted = None
            customer.address_latitude = None
            customer.address_longitude = None
            customer.address_location_status = SiteLocationStatus.UNCHECKED
        if contact_values is not None:
            customer.contacts = [CustomerContact(**contact) for contact in contact_values]
        if email_label_values is not None:
            sync_customer_email_labels(customer, email_label_values, self.db)

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
        customer = self.customers.get_including_deleted(customer_id)
        if customer is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Kunde nicht gefunden.")
        if customer.deleted_at is not None:
            return customer

        old_value = customer_snapshot(customer)
        deleted_at = datetime.now(timezone.utc)
        customer.is_active = False
        customer.deleted_at = deleted_at
        customer.deleted_by = user_id
        customer.deleted_tombstone_id = f"deleted::{customer.id}::{deleted_at.strftime('%Y%m%dT%H%M%S%fZ')}"
        self.audit.record(
            user_id=user_id,
            action="customer.deleted",
            entity_type="customer",
            entity_id=customer.id,
            old_value=old_value,
            new_value=customer_snapshot(customer),
        )
        self.db.commit()
        self.db.refresh(customer)
        return customer


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
    if "email_addresses" in cleaned:
        cleaned["email_addresses"] = clean_customer_email_labels(cleaned.get("email_addresses") or [])
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


def clean_customer_email_labels(email_labels: list[dict]) -> list[dict]:
    cleaned_labels: dict[str, dict] = {}
    for raw_label in email_labels:
        email = raw_label.get("email")
        cleaned_email = email.strip() if isinstance(email, str) else ""
        if not cleaned_email:
            continue
        validate_email(cleaned_email, "E-Mail-Adresse")
        label = raw_label.get("label")
        cleaned_label = label.strip() if isinstance(label, str) else None
        normalized_email = normalize_email_key(cleaned_email)
        cleaned_labels[normalized_email] = {
            "email": cleaned_email,
            "email_normalized": normalized_email,
            "label": cleaned_label or None,
        }
    return list(cleaned_labels.values())


def sync_customer_email_labels(customer: Customer, email_labels: list[dict], db: Session) -> None:
    existing_labels = {
        label.email_normalized: label
        for label in db.scalars(
            select(CustomerEmailLabel).where(CustomerEmailLabel.customer_id == customer.id)
        )
    }
    next_keys = {label["email_normalized"] for label in email_labels}

    for removed_key, removed_label in existing_labels.items():
        if removed_key not in next_keys:
            db.delete(removed_label)

    for label in email_labels:
        existing_label = existing_labels.get(label["email_normalized"])
        if existing_label:
            existing_label.email = label["email"]
            existing_label.label = label["label"]
        else:
            db.add(
                CustomerEmailLabel(
                    customer_id=customer.id,
                    email=label["email"],
                    email_normalized=label["email_normalized"],
                    label=label["label"],
                )
            )


def customer_email_addresses(customer: Customer, db: Session) -> list[CustomerEmailAddressRead]:
    items: dict[str, CustomerEmailAddressRead] = {}
    manual_labels = {
        label.email_normalized: label.label or ""
        for label in db.scalars(
            select(CustomerEmailLabel).where(CustomerEmailLabel.customer_id == customer.id)
        )
    }

    def add_email(
        email: str | None,
        label: str | None,
        source: str,
        created_at=None,
    ) -> None:
        cleaned_email = email.strip() if isinstance(email, str) else ""
        if not cleaned_email:
            return
        normalized_email = normalize_email_key(cleaned_email)
        if "@" not in normalized_email:
            return
        items.setdefault(
            normalized_email,
            CustomerEmailAddressRead(
                email=cleaned_email,
                label=manual_labels[normalized_email] if normalized_email in manual_labels else label,
                source=source,
                created_at=created_at,
            ),
        )

    add_email(customer.project_lead_email, customer.project_lead_name or "Projektleiter Kunde", "customer_project_lead")
    for contact in customer.contacts:
        add_email(contact.email, contact.name, f"customer_contact:{contact.contact_type}")

    customer_key = normalize_customer_match_text(customer.company_name)
    if customer_key:
        site_recipients = db.execute(
            select(SiteEmailRecipient, Site)
            .join(Site, SiteEmailRecipient.site_id == Site.id)
            .where(SiteEmailRecipient.email.is_not(None))
        ).all()
        for recipient, site in site_recipients:
            if normalize_customer_match_text(site.customer) != customer_key:
                continue
            add_email(
                recipient.email,
                recipient.label or "Mobile E-Mail",
                recipient.source or "mobile_email",
                recipient.created_at,
            )

    return sorted(items.values(), key=lambda item: item.email.casefold())


def normalize_customer_match_text(value: str | None) -> str:
    return " ".join((value or "").casefold().split())


def normalize_email_key(value: str) -> str:
    return value.strip().casefold()


def customer_snapshot(customer: Customer) -> dict:
    deleted_at = getattr(customer, "deleted_at", None)
    return {
        "id": customer.id,
        "company_name": customer.company_name,
        "address_street": customer.address_street,
        "address_house_number": customer.address_house_number,
        "address_postal_code": customer.address_postal_code,
        "address_city": customer.address_city,
        "address_country": customer.address_country,
        "address_extra": getattr(customer, "address_extra", None),
        "address_formatted": getattr(customer, "address_formatted", None),
        "address_latitude": getattr(customer, "address_latitude", None),
        "address_longitude": getattr(customer, "address_longitude", None),
        "address_location_status": getattr(customer, "address_location_status", SiteLocationStatus.UNCHECKED).value,
        "company_phone": customer.company_phone,
        "project_lead_name": customer.project_lead_name,
        "project_lead_phone": customer.project_lead_phone,
        "project_lead_email": customer.project_lead_email,
        "is_active": customer.is_active,
        "deleted_at": deleted_at.isoformat() if deleted_at else None,
        "deleted_by": getattr(customer, "deleted_by", None),
        "deleted_tombstone_id": getattr(customer, "deleted_tombstone_id", None),
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
        "email_labels": [
            {
                "email": label.email,
                "label": label.label,
            }
            for label in getattr(customer, "email_labels", [])
        ],
    }


def apply_selected_customer_geocode(values: dict) -> bool:
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
