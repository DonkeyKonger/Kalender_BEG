from datetime import date
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.dependencies import get_current_app_user
from app.core.database import get_db
from app.main import create_app
from app.models.assignment import Assignment
from app.models.customer import Customer, CustomerContact
from app.models.enums import UserRole
from app.models.person import Person
from app.models.site import Site
from app.models.site_email_recipient import SiteEmailRecipient
from app.schemas.site_email_recipient import SiteEmailRecipientPayload, SiteEmailRecipientsUpdate
from app.services.customer_service import CustomerService
from app.services.extra_work_email_service import ExtraWorkEmailService
from app.services.site_email_recipient_service import SiteEmailRecipientService
from app.tests.test_extra_work_service import db_session


@pytest.fixture
def data():
    with db_session() as db:
        worker = Person(first_name="Max", last_name="Monteur", display_name="Max Monteur", short_code="MM")
        colleague = Person(first_name="Andere", last_name="Person", display_name="Andere Person", short_code="AP")
        customer = Customer(company_name="Kunde GmbH", project_lead_email="Leitung@kunde.example")
        customer.contacts = [CustomerContact(name="Bauleiter", email=" Bauleiter@kunde.example ")]
        sites = [Site(site_number=str(8000 + i), name=f"Baustelle {i}", customer=customer.company_name)
                 for i in range(3)]
        db.add_all([worker, colleague, customer, *sites])
        db.flush()
        assignments = [Assignment(person_id=worker.id, site_id=site.id,
                                  start_date=date(2026, 9, 18), end_date=date(2026, 9, 18))
                       for site in sites]
        same_site = Assignment(person_id=colleague.id, site_id=sites[0].id,
                               start_date=date(2026, 9, 19), end_date=date(2026, 9, 19))
        db.add_all([*assignments, same_site])
        db.commit()
        user = SimpleNamespace(id=1, person_id=worker.id, role=UserRole.MONTEUR)
        yield db, customer, assignments, same_site, user


def save(db, assignment, user, *emails):
    return SiteEmailRecipientService(db).update_for_assignment(
        assignment_id=assignment.id, current_user=user,
        payload=SiteEmailRecipientsUpdate(
            recipients=[SiteEmailRecipientPayload(email=email) for email in emails]),
    )


def test_addresses_stay_site_scoped_but_remain_in_customer_directory(data):
    db, customer, assignments, same_site, user = data
    service = SiteEmailRecipientService(db)
    for assignment in assignments:
        assert service.get_for_assignment(assignment_id=assignment.id, current_user=user).suggestions == []

    save(db, assignments[0], user, " Neu@kunde.example ", "NEU@KUNDE.EXAMPLE")
    save(db, assignments[1], user, "andere@kunde.example")
    assert service.get_for_assignment(assignment_id=assignments[2].id, current_user=user).suggestions == []
    for assignment, expected in zip(assignments[:2], ["neu@kunde.example", "andere@kunde.example"]):
        response = service.get_for_assignment(assignment_id=assignment.id, current_user=user)
        assert [row.email for row in response.suggestions] == [expected]
        assert [row.email for row in response.recipients] == [expected]
        assert ExtraWorkEmailService(db)._selected_recipients(assignment.site_id) == [expected]

    # Site membership is permanent, not tied to one worker or one day's assignment.
    with Session(db.get_bind()) as fresh_db:
        response = SiteEmailRecipientService(fresh_db).get_for_assignment(
            assignment_id=same_site.id,
            current_user=SimpleNamespace(person_id=same_site.person_id),
        )
        assert [row.email for row in response.recipients] == ["neu@kunde.example"]
    customer_read = CustomerService(db).read_customer(customer)
    assert {row.email.strip().lower() for row in customer_read.email_addresses} == {
        "leitung@kunde.example", "bauleiter@kunde.example", "neu@kunde.example", "andere@kunde.example",
    }


@pytest.mark.parametrize("email", ["bauleiter@kunde.example", "leitung@kunde.example", "neu@kunde.example"])
def test_reentering_known_customer_address_links_each_site_without_customer_duplicates(data, email):
    db, customer, assignments, _, user = data
    for assignment in assignments[:2]:
        response = save(db, assignment, user, f" {email.upper()} ", email)
        assert [row.email for row in response.recipients] == [email]
        assert [row.email for row in response.suggestions] == [email]
    save(db, assignments[0], user, email)
    contacts = db.scalars(select(CustomerContact).where(CustomerContact.customer_id == customer.id)).all()
    assert sum((contact.email or "").strip().lower() == email for contact in contacts) == (
        0 if email == "leitung@kunde.example" else 1
    )
    assert db.scalar(select(CustomerContact).where(CustomerContact.name == "Bauleiter")) is not None
    stored = db.scalars(select(SiteEmailRecipient).where(SiteEmailRecipient.email == email)).all()
    assert {row.site_id for row in stored} == {assignment.site_id for assignment in assignments[:2]}
    assert len(stored) == 2


def test_deselection_preserves_site_address_and_customer_contact(data):
    db, customer, assignments, _, user = data
    save(db, assignments[0], user, "neu@kunde.example")
    response = save(db, assignments[0], user)
    assert response.recipients == []
    assert [row.email for row in response.suggestions] == ["neu@kunde.example"]
    assert response.suggestions[0].is_selected is False
    assert ExtraWorkEmailService(db)._selected_recipients(assignments[0].site_id) == []
    assert "neu@kunde.example" in {row.email for row in CustomerService(db).read_customer(customer).email_addresses}
    response = save(db, assignments[0], user, "neu@kunde.example")
    assert response.recipients[0].id == response.suggestions[0].id
    assert response.suggestions[0].is_selected is True


def test_mobile_endpoints_do_not_expose_customer_directory_or_other_workers_assignments(data):
    db, _, assignments, same_site, user = data
    app = create_app()
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_app_user] = lambda: user
    client = TestClient(app)
    path = f"/api/me/assignments/{assignments[0].id}/email-recipients"
    assert client.get(path).json()["suggestions"] == []
    response = client.put(path, json={"recipients": [{"email": "NEU@KUNDE.EXAMPLE"}]})
    assert response.status_code == 200
    assert [row["email"] for row in response.json()["suggestions"]] == ["neu@kunde.example"]
    assert client.get(f"/api/me/assignments/{assignments[1].id}/email-recipients").json()["suggestions"] == []
    forbidden_path = f"/api/me/assignments/{same_site.id}/email-recipients"
    assert client.get(forbidden_path).status_code == 404
    assert client.put(forbidden_path, json={"recipients": []}).status_code == 404
