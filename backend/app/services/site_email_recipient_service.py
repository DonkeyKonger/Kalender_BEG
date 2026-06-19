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
        site = self._get_site(assignment.site_id)
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
        suggestion_by_email = {
            suggestion.email: suggestion
            for suggestion in self._customer_suggestions(site)
        }
        for recipient in stored:
            suggestion_by_email.setdefault(recipient.email, self._read_recipient(recipient))
        for recipient in selected:
            if recipient.email in suggestion_by_email:
                suggestion_by_email[recipient.email].is_selected = True
                suggestion_by_email[recipient.email].id = recipient.id

        return SiteEmailRecipientsResponse(
            site_id=site.id,
            recipients=selected,
            suggestions=sorted(suggestion_by_email.values(), key=lambda item: item.email),
        )

    def _customer_suggestions(self, site: Site) -> list[SiteEmailRecipientRead]:
        suggestions: dict[str, SiteEmailRecipientRead] = {}
        for customer in self._matching_customers(site):
            if customer.project_lead_email:
                try:
                    email = normalize_email(customer.project_lead_email)
                    suggestions[email] = SiteEmailRecipientRead(
                        email=email,
                        label=customer.project_lead_name or customer.company_name,
                        source="customer_project_lead",
                    )
                except HTTPException:
                    pass
            for contact in customer.contacts:
                if not contact.email:
                    continue
                try:
                    email = normalize_email(contact.email)
                    suggestions.setdefault(
                        email,
                        SiteEmailRecipientRead(
                            email=email,
                            label=contact.name,
                            source="customer_contact",
                        ),
                    )
                except HTTPException:
                    continue
        return list(suggestions.values())

    def _ensure_customer_contact(self, site: Site, recipient: SiteEmailRecipientPayload) -> None:
        matching_customers = self._matching_customers(site)
        if len(matching_customers) != 1:
            return
        customer = matching_customers[0]
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
                .where(Customer.is_active.is_(True))
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

    def _get_site(self, site_id: int) -> Site:
        site = self.db.get(Site, site_id)
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
