from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.assignment import Assignment
from app.models.customer import Customer, CustomerContact
from app.models.site import Site
from app.models.site_email_recipient import SiteEmailRecipient
from app.models.user import User
from app.schemas.site_email_recipient import (
    SiteEmailRecipientPayload,
    SiteEmailRecipientRead,
    SiteEmailRecipientsResponse,
    SiteEmailRecipientsUpdate,
)


class SiteEmailRecipientService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get_for_assignment(self, *, assignment_id: int, current_user: User) -> SiteEmailRecipientsResponse:
        assignment = self._get_user_assignment(assignment_id, current_user)
        site = self._get_site(assignment.site_id)
        return self._build_response(site)

    def update_for_assignment(
        self,
        *,
        assignment_id: int,
        current_user: User,
        payload: SiteEmailRecipientsUpdate,
    ) -> SiteEmailRecipientsResponse:
        assignment = self._get_user_assignment(assignment_id, current_user)
        site = self._get_site(assignment.site_id, for_update=True)
        existing = {
            recipient.email: recipient
            for recipient in self.db.scalars(
                select(SiteEmailRecipient).where(SiteEmailRecipient.site_id == site.id)
            ).all()
        }
        normalized_payload = self._deduplicate_payload(payload.recipients)
        next_emails = {recipient.email for recipient in normalized_payload}

        for recipient in existing.values():
            recipient.is_selected = recipient.email in next_emails

        for recipient_payload in normalized_payload:
            recipient = existing.get(recipient_payload.email)
            if recipient is None:
                recipient = SiteEmailRecipient(
                    site_id=site.id,
                    email=recipient_payload.email,
                    source="manual",
                    is_selected=True,
                )
                self.db.add(recipient)
            recipient.label = recipient_payload.label
            recipient.is_selected = True
            self._ensure_customer_contact(site, recipient_payload)

        self.db.commit()
        return self._build_response(site)

    def _build_response(self, site: Site) -> SiteEmailRecipientsResponse:
        stored = list(
            self.db.scalars(
                select(SiteEmailRecipient)
                .where(SiteEmailRecipient.site_id == site.id)
                .order_by(SiteEmailRecipient.email)
            ).all()
        )
        selected = [
            self._read_recipient(recipient)
            for recipient in stored
            if recipient.is_selected
        ]
        # Mobile users only see addresses explicitly saved for this site, including
        # previously deselected recipients. Customer-wide contacts stay in the office.
        return SiteEmailRecipientsResponse(
            site_id=site.id,
            recipients=selected,
            suggestions=[self._read_recipient(recipient) for recipient in stored],
        )

    def _ensure_customer_contact(self, site: Site, recipient: SiteEmailRecipientPayload) -> None:
        matching_customers = self._matching_customers(site)
        if len(matching_customers) != 1:
            return
        # Serialize mobile additions across sites of the same customer. Reload the
        # contacts after acquiring the lock so simultaneous entries cannot duplicate it.
        customer = self.db.scalar(
            select(Customer)
            .where(Customer.id == matching_customers[0].id)
            .with_for_update()
            .options(selectinload(Customer.contacts))
            .execution_options(populate_existing=True)
        )
        if customer is None:
            return
        known_emails = set()
        if customer.project_lead_email:
            try:
                known_emails.add(normalize_email(customer.project_lead_email))
            except HTTPException:
                pass
        for contact in customer.contacts:
            if contact.email:
                try:
                    known_emails.add(normalize_email(contact.email))
                except HTTPException:
                    continue
        if recipient.email in known_emails:
            return
        self.db.add(
            CustomerContact(
                customer=customer,
                contact_type="mobile_email",
                name=recipient.label or "Mobile E-Mail",
                email=recipient.email,
            )
        )

    def _matching_customers(self, site: Site) -> list[Customer]:
        customer_name = _normalize_match_text(site.customer)
        if not customer_name:
            return []
        customers = list(
            self.db.scalars(
                select(Customer)
                .options(selectinload(Customer.contacts))
                .where(Customer.is_active.is_(True), Customer.deleted_at.is_(None))
            ).all()
        )
        return [
            customer
            for customer in customers
            if _normalize_match_text(customer.company_name) == customer_name
        ]

    def _get_user_assignment(self, assignment_id: int, current_user: User) -> Assignment:
        if current_user.person_id is None:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Dieser Benutzer ist keiner Person zugeordnet.")
        assignment = self.db.scalar(
            select(Assignment).where(
                Assignment.id == assignment_id,
                Assignment.person_id == current_user.person_id,
            )
        )
        if assignment is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Einsatz nicht gefunden.")
        return assignment

    def _get_site(self, site_id: int, *, for_update: bool = False) -> Site:
        statement = select(Site).where(Site.id == site_id)
        if for_update:
            statement = statement.with_for_update()
        site = self.db.scalar(statement)
        if site is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Baustelle nicht gefunden.")
        return site

    @staticmethod
    def _deduplicate_payload(recipients: list[SiteEmailRecipientPayload]) -> list[SiteEmailRecipientPayload]:
        deduplicated: dict[str, SiteEmailRecipientPayload] = {}
        for recipient in recipients:
            deduplicated[recipient.email] = recipient
        return list(deduplicated.values())

    @staticmethod
    def _read_recipient(recipient: SiteEmailRecipient) -> SiteEmailRecipientRead:
        return SiteEmailRecipientRead(
            id=recipient.id,
            email=recipient.email,
            label=recipient.label,
            source=recipient.source,
            is_selected=recipient.is_selected,
            created_at=recipient.created_at,
            updated_at=recipient.updated_at,
        )


def normalize_email(value: str) -> str:
    cleaned = value.strip().lower()
    if "@" not in cleaned or "." not in cleaned.rsplit("@", 1)[-1]:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "E-Mail-Adresse ist nicht gueltig.")
    return cleaned


def _normalize_match_text(value: str | None) -> str:
    return " ".join((value or "").casefold().split())
