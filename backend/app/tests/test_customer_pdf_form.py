from datetime import date, datetime, timezone
from io import BytesIO
from types import SimpleNamespace

import pytest
from pypdf import PdfReader, PdfWriter

from app.core.config import settings
from app.models.assignment import Assignment
from app.models.person import Person
from app.models.site_email_recipient import SiteEmailRecipient
from app.services import extra_work_email_service as email_module
from app.models.extra_work_ticket import ExtraWorkTicket, ExtraWorkTicketEntry
from app.models.site_measurement_item import SiteMeasurementBatch
from app.services.extra_work_pdf_service import ExtraWorkPdfService
from app.services.measurement_group_pdf import render_group_pdf
from app.services.measurement_pdf_service import MeasurementPdfService
from app.tests.test_measurement_groups import INK, create_group, setup_group
from app.tests.test_measurement_service import create_site, db_session


MEASUREMENT_FIELDS = {
    "customer_place_date": "/Tx",
    "customer_name": "/Tx",
    "customer_signature": "/Sig",
}
EXTRA_FIELDS = {"customer_place": "/Tx", "customer_date": "/Tx", "customer_signature": "/Sig"}


@pytest.fixture(autouse=True)
def isolated_pdf_cache(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "document_pdf_cache_dir", str(tmp_path))


def assert_form(content, expected, page_index):
    reader = PdfReader(BytesIO(content))
    fields = reader.get_fields()
    assert {name: field["/FT"] for name, field in fields.items()} == expected
    assert "/V" not in fields["customer_signature"]  # Empty signing field, not a fake signature.
    root = reader.trailer["/Root"]
    assert all(key not in root for key in ("/Names", "/OpenAction", "/AA"))
    assert b"/JavaScript" not in content and b"/JS" not in content
    refs = root["/AcroForm"]["/Fields"]
    assert not root["/AcroForm"]["/NeedAppearances"].value
    for index, page in enumerate(reader.pages):
        widgets = page.get("/Annots", [])
        assert len(widgets) == (len(expected) if index == page_index else 0)
        for ref in widgets:
            assert ref in refs
            widget = ref.get_object()
            assert widget["/P"].indirect_reference == page.indirect_reference
            assert widget["/Ff"] == 0
            assert widget["/F"] == 4
            x1, y1, x2, y2 = widget["/Rect"]
            assert 0 <= x1 < x2 <= page.mediabox.width
            assert 0 <= y1 < y2 <= page.mediabox.height
            assert widget["/AP"]["/N"]["/Subtype"] == "/Form"
            if widget["/FT"] == "/Tx":
                assert b"BT" in widget["/AP"]["/N"].get_data()
    # Fill, save, reopen: both canonical values and printable widget appearances persist.
    writer = PdfWriter(clone_from=reader)
    values = {key: "Müller / 25.09.2026" for key, kind in expected.items() if kind == "/Tx"}
    writer.update_page_form_field_values(writer.pages[page_index], values, auto_regenerate=False)
    output = BytesIO()
    writer.write(output)
    filled = PdfReader(BytesIO(output.getvalue()))
    for key, value in values.items():
        assert filled.get_fields()[key]["/V"] == value
    for ref in filled.pages[page_index]["/Annots"]:
        widget = ref.get_object()
        if widget["/FT"] == "/Tx":
            assert widget["/V"] == values[widget["/T"]]
            assert b"Tj" in widget["/AP"]["/N"].get_data()
    return reader


@pytest.mark.parametrize(
    "origin,mode", [("MONTEUR", "checked"), ("MONTEUR", "original"), ("OFFICE", "checked")]
)
@pytest.mark.parametrize("signed", [False, True])
def test_measurement_customer_fields_for_every_mode_and_origin(origin, mode, signed, monkeypatch):
    with db_session() as db:
        site = create_site(db)
        site.city = "Hamburg"
        batch = SiteMeasurementBatch(
            site=site,
            number=1,
            title="Aufmaß",
            status="reviewed",
            origin=origin,
            customer_signature_name="Müller",
            worker_signature_name="Monteur",
            worker_signature_strokes=INK,
            customer_signed_at=datetime(2026, 9, 25, tzinfo=timezone.utc) if signed else None,
            customer_signature_strokes=INK if signed else None,
        )
        db.add(batch)
        db.commit()
        service = MeasurementPdfService(db)

        def photo_appendix(content, _batch):
            writer = PdfWriter(clone_from=PdfReader(BytesIO(content)))
            writer.add_blank_page(595, 842)
            output = BytesIO()
            writer.write(output)
            return output.getvalue()

        monkeypatch.setattr(service, "_append_photo_pages", photo_appendix)
        content, _ = service.build_batch_pdf(site_id=site.id, batch_id=batch.id, mode=mode)
        if signed:
            assert not PdfReader(BytesIO(content)).get_fields()
        else:
            reader = assert_form(content, MEASUREMENT_FIELDS, 0)
            assert reader.get_fields()["customer_name"]["/V"] == "Müller"
            assert reader.get_fields()["customer_place_date"]["/V"] == "Hamburg"
            widget = reader.pages[0]["/Annots"][0].get_object()
            assert widget["/Rect"][1] == (47 if origin == "OFFICE" else 15)
            cached, _ = service.build_batch_pdf(site_id=site.id, batch_id=batch.id, mode=mode)
            assert cached == content


@pytest.mark.parametrize("signed", [False, True])
@pytest.mark.parametrize("kind", ["billing", "approval"])
def test_extra_work_fields_on_last_document_sheet_before_photos(signed, kind, monkeypatch):
    with db_session() as db:
        site = create_site(db)
        site.city = "Hamburg"
        ticket = ExtraWorkTicket(
            site=site,
            sequence_number=1,
            display_number="8007.Z01",
            kind=kind,
            status="signed" if signed else "draft",
            worker_signature_place="Hamburg",
            worker_signature_strokes=INK,
            customer_signed_at=datetime(2026, 9, 25, tzinfo=timezone.utc) if signed else None,
            customer_signature_strokes=INK if signed else None,
        )
        ticket.entries = [
            ExtraWorkTicketEntry(
                site=site,
                component="BT A",
                floor="EG",
                worker_rows=[{"worker_name": f"Monteur {i}"} for i in range(4)],
            )
        ]
        db.add(ticket)
        db.commit()
        service = ExtraWorkPdfService(db)
        monkeypatch.setattr(
            service,
            "_append_photo_pages",
            lambda writer, *args, **kwargs: writer.add_blank_page(595, 842),
        )
        content = service._build_ticket_pdf(ticket=ticket, assignment=None)
        assert len(PdfReader(BytesIO(content)).pages) == 3
        if signed:
            assert not PdfReader(BytesIO(content)).get_fields()
        else:
            reader = assert_form(content, EXTRA_FIELDS, 1)
            assert reader.get_fields()["customer_place"]["/V"] == "Hamburg"
            assert reader.get_fields()["customer_date"]["/V"] == ""


@pytest.mark.parametrize("signed", [False, True])
def test_combined_measurement_keeps_customer_fields_before_worker_appendix(signed):
    with db_session() as db:
        site, user, batches = setup_group(db)
        if not signed:
            batches[0].customer_signed_at = None
            batches[0].customer_signature_strokes = None
            db.commit()
        group = create_group(db, site, user, batches)
        content = render_group_pdf(group)
        assert len(PdfReader(BytesIO(content)).pages) == 2
        if signed:
            assert not PdfReader(BytesIO(content)).get_fields()
        else:
            assert_form(content, MEASUREMENT_FIELDS, 0)


@pytest.mark.parametrize("document", ["measurement", "extra_work"])
def test_download_and_email_attachment_share_the_real_fillable_pdf(document, monkeypatch):
    with db_session() as db:
        site = create_site(db)
        person = Person(
            first_name="Max", last_name="Monteur", display_name="Max Monteur", short_code="MM"
        )
        db.add(person)
        db.flush()
        assignment = Assignment(
            site=site, person_id=person.id, start_date=date(2026, 9, 25), end_date=date(2026, 9, 25)
        )
        db.add_all(
            [
                assignment,
                SiteEmailRecipient(
                    site=site, email="kunde@example.invalid", source="manual", is_selected=True
                ),
            ]
        )
        batch = SiteMeasurementBatch(site=site, number=1, title="Aufmaß", status="submitted")
        ticket = ExtraWorkTicket(
            site=site,
            sequence_number=1,
            display_number="8007.Z01",
            kind="billing",
            status="draft",
            worker_signed_at=datetime(2026, 9, 25, tzinfo=timezone.utc),
            worker_signature_strokes=INK,
        )
        db.add_all([batch, ticket])
        db.commit()
        user = SimpleNamespace(id=None, person_id=person.id)
        deliveries = []

        class FakeDelivery:
            def send_document_email(self, **kwargs):
                deliveries.append(kwargs["attachment"].content)

        monkeypatch.setattr(email_module, "EmailDeliveryService", FakeDelivery)
        emails = email_module.ExtraWorkEmailService(db)
        if document == "measurement":
            downloaded, _ = MeasurementPdfService(db).build_batch_pdf(
                site_id=site.id, batch_id=batch.id
            )
            emails.send_mobile_measurement_batch_email(
                assignment_id=assignment.id, batch_id=batch.id, current_user=user
            )
            expected = MEASUREMENT_FIELDS
        else:
            service = ExtraWorkPdfService(db)
            downloaded, _ = service.build_site_ticket_pdf(site_id=site.id, ticket_id=ticket.id)
            mobile, _ = service.build_mobile_ticket_pdf(
                assignment_id=assignment.id, ticket_id=ticket.id, current_user=user
            )
            assert mobile == downloaded
            emails.send_mobile_ticket_email(
                assignment_id=assignment.id, ticket_id=ticket.id, current_user=user
            )
            expected = EXTRA_FIELDS
        assert deliveries == [downloaded]
        assert_form(deliveries[0], expected, 0)
