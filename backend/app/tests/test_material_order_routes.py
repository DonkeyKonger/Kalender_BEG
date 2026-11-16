from types import SimpleNamespace

from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.api.dependencies import get_current_user
from app.core.database import get_db
from app.main import create_app
from app.models import Base
from app.models.enums import UserRole
from app.models.material_order import MaterialOrderDraft
from app.models.site import Site
from app.models.user import User


def test_material_order_draft_form_and_template_require_sites_edit_permission():
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    db = Session(engine)
    site = Site(site_number="8001", name="Route Test", customer="Kunde")
    user = User(
        username="route-user",
        display_name="Route User",
        password_hash="x",
        role=UserRole.OFFICE,
        office_page_permissions=["sites"],
    )
    db.add_all([site, user])
    db.commit()

    app = create_app()
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_user] = lambda: user
    client = TestClient(app)

    draft = client.post(f"/api/sites/{site.id}/material-orders/draft")
    descriptor = client.get(f"/api/sites/{site.id}/material-orders/form")
    template = client.get(f"/api/sites/{site.id}/material-orders/template")

    assert draft.status_code == 200
    assert draft.json()["values"]["project"] == "Route Test"
    assert descriptor.status_code == 200
    assert descriptor.json()["fields"][0]["max_length"] == 120
    assert template.status_code == 200
    assert template.headers["content-type"] == "application/pdf"
    assert template.content.startswith(b"%PDF")

    other_site = Site(site_number="8002", name="Andere Route")
    other_user = User(
        username="other-route-user",
        display_name="Other Route User",
        password_hash="x",
        role=UserRole.OFFICE,
        office_page_permissions=["sites"],
    )
    db.add_all([other_site, other_user])
    db.commit()
    draft_id = draft.json()["id"]
    update_payload = {"revision": 0, "values": {"material_1": "Kabelrinne"}}

    stored_draft = db.get(MaterialOrderDraft, draft_id)
    stored_draft.status = "completed"
    stored_draft.filename = "261116_Lagerbestellung.pdf"
    stored_draft.completed_document = {
        "id": "document-1",
        "name": "261116_Lagerbestellung.pdf",
        "mime_type": "application/pdf",
        "file_extension": "pdf",
        "is_folder": False,
    }
    db.commit()
    completed_read = client.get(f"/api/sites/{site.id}/material-orders/{draft_id}")
    assert completed_read.status_code == 200
    assert completed_read.json()["status"] == "completed"
    assert completed_read.json()["completion_pending"] is False
    assert completed_read.json()["document"]["id"] == "document-1"

    app.dependency_overrides[get_current_user] = lambda: other_user
    assert client.get(
        f"/api/sites/{site.id}/material-orders/{draft_id}"
    ).status_code == 404
    assert client.put(
        f"/api/sites/{site.id}/material-orders/{draft_id}",
        json=update_payload,
    ).status_code == 404

    app.dependency_overrides[get_current_user] = lambda: user
    assert client.get(
        f"/api/sites/{other_site.id}/material-orders/{draft_id}"
    ).status_code == 404
    assert client.put(
        f"/api/sites/{other_site.id}/material-orders/{draft_id}",
        json=update_payload,
    ).status_code == 404

    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        id=user.id,
        role=UserRole.OFFICE,
        is_active=True,
        must_change_password=False,
        office_page_permissions=["calendar"],
    )
    assert client.post(f"/api/sites/{site.id}/material-orders/draft").status_code == 403

    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(
        id=user.id,
        role=UserRole.MONTEUR,
        is_active=True,
        must_change_password=False,
        office_page_permissions=[],
    )
    assert client.get(f"/api/sites/{site.id}/material-orders/form").status_code == 403

    app.dependency_overrides.clear()
    db.close()
