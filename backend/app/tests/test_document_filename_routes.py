from types import SimpleNamespace
from urllib.parse import unquote

import pytest
from fastapi.testclient import TestClient

from app.api.dependencies import get_current_app_user, get_current_user
from app.api.routes import me, sites
from app.core.database import get_db
from app.main import create_app
from app.models.enums import UserRole


@pytest.mark.parametrize("path,filename", [
    ("/api/sites/1/measurement-batches/3/pdf", "8031.03_261103_CHC_Emden.pdf"),
    ("/api/sites/1/measurement-batches/3/pdf?mode=original", "8031.03_261103_CHC_Emden.pdf"),
    ("/api/me/assignments/1/measurement-batches/3/pdf", "8031.03_261103_CHC_Emden.pdf"),
    ("/api/sites/1/extra-work-tickets/3/pdf", "8031.Z03_261103_CHC_Emden.pdf"),
    ("/api/me/assignments/1/extra-work-tickets/3/pdf", "8031.Z03_261103_CHC_Emden.pdf"),
    ("/api/sites/1/measurement-groups/3/pdf", "8031.03G_261103_CHC_Emden.pdf"),
])
def test_all_pdf_routes_deliver_the_canonical_filename_to_cross_origin_clients(monkeypatch, path, filename):
    # Exercise response headers and real CORS middleware, including Unicode site names.
    filename = filename.replace("CHC_Emden", "CHC_Emden_Süd")
    monkeypatch.setattr(sites.MeasurementPdfService, "build_batch_pdf", lambda self, **kwargs: (b"%PDF-test", filename))
    monkeypatch.setattr(sites.ExtraWorkPdfService, "build_site_ticket_pdf", lambda self, **kwargs: (b"%PDF-test", filename))
    monkeypatch.setattr(me.ExtraWorkPdfService, "build_mobile_ticket_pdf", lambda self, **kwargs: (b"%PDF-test", filename))
    monkeypatch.setattr(sites.MeasurementGroupService, "pdf", lambda *args: (b"%PDF-test", filename))
    monkeypatch.setattr(me.MeasurementService, "_get_user_assignment", lambda *args: SimpleNamespace(site_id=1))
    app = create_app()
    user = SimpleNamespace(id=7, role=UserRole.ADMIN, is_active=True, must_change_password=False)
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_current_app_user] = lambda: user
    app.dependency_overrides[get_db] = lambda: None
    response = TestClient(app).get(path, headers={"Origin": "http://localhost:5173"})
    assert response.status_code == 200
    assert response.content == b"%PDF-test"
    assert unquote(response.headers["Content-Disposition"].split("UTF-8''", 1)[1]) == filename
    assert "content-disposition" in response.headers["Access-Control-Expose-Headers"].lower()
