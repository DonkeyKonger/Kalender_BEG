from datetime import date, datetime, timezone
from io import BytesIO
import re

from pypdf import PdfReader
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.models import Base
from app.models.assignment import Assignment
from app.models.enums import UserRole
from app.models.extra_work_ticket import ExtraWorkTicket, ExtraWorkTicketEntry
from app.models.person import Person
from app.models.site import Site
from app.models.user import User
from app.services import extra_work_pdf_service as pdf_module
from app.services.extra_work_pdf_service import (
    CHECKBOX_CENTERS,
    ExtraWorkPdfService,
    OverlayPdf,
)


def db_session() -> Session:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return Session(engine)


def _assert_non_interactive(reader: PdfReader, content: bytes) -> None:
    root = reader.trailer["/Root"]
    assert "/AcroForm" not in root
    assert "/Names" not in root
    assert "/OpenAction" not in root
    assert "/AA" not in root
    assert all("/Annots" not in page and "/AA" not in page for page in reader.pages)
    assert b"/JavaScript" not in content
    assert b"/JS" not in content


def test_structured_and_legacy_material_share_the_existing_pdf_output():
    entry = ExtraWorkTicketEntry(
        material_text="Legacy-Klemmen",
        material_items=[
            {"quantity": 2, "unit": "x", "description": "Stiel US 5 bis 500"},
            {"quantity": 2.5, "unit": "m", "description": "Kabelrinne"},
            {"quantity": None, "unit": None, "description": "Kleinmaterial Befestigung"},
        ],
    )

    assert pdf_module._format_extra_work_material(entry) == (
        "Legacy-Klemmen\n"
        "2x Stiel US 5 bis 500\n"
        "2,5 m Kabelrinne\n"
        "Kleinmaterial Befestigung"
    )


def test_clean_master_template_is_cached_and_has_no_interactive_or_default_zero_values():
    service = ExtraWorkPdfService(db_session())

    first = service.build_clean_template_pdf()
    second = service.build_clean_template_pdf()
    reader = PdfReader(BytesIO(first))
    text = "\n".join(page.extract_text() or "" for page in reader.pages)

    assert first is second
    assert first.startswith(b"%PDF")
    assert len(reader.pages) == 1
    assert reader.get_fields() is None
    _assert_non_interactive(reader, first)
    assert "Zusatzauftrag" in text
    assert not re.search(r"(?m)^\s*0(?:[,.]0{1,2})?\s*$", text)


def test_master_overlay_defines_the_bold_f2_font_resource():
    overlay = OverlayPdf()
    overlay.add_page([b"BT /F2 10 Tf 42 700 Td (Fett) Tj ET"])

    reader = PdfReader(BytesIO(overlay.build()))
    fonts = reader.pages[0]["/Resources"]["/Font"]

    assert fonts["/F2"].get_object()["/BaseFont"] == "/Helvetica-Bold"
    assert reader.pages[0].extract_text() == "Fett"


def test_desktop_fields_surcharges_and_exact_checkbox_mapping_are_rendered(monkeypatch):
    db = db_session()
    worker = Person(
        first_name="Max",
        last_name="Monteur",
        display_name="Max Monteur",
        short_code="MM",
    )
    unrelated = Person(
        first_name="Andere",
        last_name="Person",
        display_name="Andere Person",
        short_code="AP",
    )
    site = Site(
        site_number="8015",
        name="FFW Barmbeck Hamburg",
        customer="Bredow GmbH",
    )
    office = User(
        username="office-pdf",
        display_name="Büro PDF",
        password_hash="x",
        role=UserRole.OFFICE,
        office_page_permissions=["sites"],
    )
    db.add_all([worker, unrelated, site, office])
    db.commit()
    db.add(
        Assignment(
            person_id=unrelated.id,
            site_id=site.id,
            start_date=date(2025, 1, 1),
            end_date=date(2025, 1, 2),
        )
    )
    ticket = ExtraWorkTicket(
        site_id=site.id,
        sequence_number=1,
        display_number="8015.SZ01",
        title="Brandschott nacharbeiten",
        kind="billing",
        status="draft",
        created_by_user_id=office.id,
        ordered_by_name="Herr Mustermann",
        ordered_by_company="Muster Auftraggeber GmbH",
        billing_type="unit_price",
        estimated_order_value=1250.5,
        material_required=False,
        material_separate_attachment=True,
        executed_by_lead_monteur=True,
        executed_by_monteur=False,
        executed_by_helper=False,
        work_description="Erste Beschreibungszeile\nZweite Beschreibungszeile",
        manual_order_date=date(2026, 8, 19),
        manual_execution_start=date(2026, 8, 17),
        manual_execution_end=date(2026, 8, 20),
        customer_signature_name="Legacy Kundenname",
    )
    db.add(ticket)
    db.flush()
    entry = ExtraWorkTicketEntry(
        ticket_id=ticket.id,
        site_id=site.id,
        component="BT A",
        floor="2. OG",
        estimated_hours=8.5,
        worker_rows=[
            {
                "person_id": worker.id,
                "worker_name": "Max Monteur",
                "monday_hours": 2,
                "monday_surcharge_25_hours": 1.5,
                "monday_surcharge_50_hours": 0.5,
            }
        ],
    )
    db.add(entry)
    db.commit()

    service = ExtraWorkPdfService(db)
    loaded = service._get_ticket(ticket.id, site.id)
    assert service._get_site_assignment_context(loaded) is None

    rendered, filename = service.build_site_ticket_pdf(
        site_id=site.id,
        ticket_id=ticket.id,
    )
    reader = PdfReader(BytesIO(rendered))
    text = "\n".join(page.extract_text() or "" for page in reader.pages)

    assert filename == "Zusatzauftrag_8015_8015.SZ01.pdf"
    assert len(reader.pages) == 1
    _assert_non_interactive(reader, rendered)
    for value in (
        "8015",
        "8015.SZ01",
        "Herr Mustermann",
        "Muster Auftraggeber GmbH",
        "Brandschott nacharbeiten",
        "Erste Beschreibungszeile",
        "Zweite Beschreibungszeile",
        "17.08.2026",
        "20.08.2026",
        "Max Monteur",
        "8,5",
        "1.250,50 €",
    ):
        assert value in text
    assert "Legacy Kundenname" not in text
    assert text.count("Herr Mustermann") == 1
    assert "2" in text and "1,5" in text and "0,5" in text and "4" in text
    assert "01.01.2025" not in text and "02.01.2025" not in text

    checked: list[tuple[float, float]] = []
    monkeypatch.setattr(
        pdf_module,
        "_checkbox",
        lambda _commands, center_x, center_y: checked.append((center_x, center_y)),
    )
    commands: list[bytes] = []
    service._draw_common_fields(commands, loaded, None, loaded.entries[0], 1, 1)

    assert set(checked) == {
        CHECKBOX_CENTERS["unit_price"],
        CHECKBOX_CENTERS["material_no"],
        (238.09, 269.67),
        (167.15, 288.56),
    }

    loaded.executed_by_lead_monteur = False
    loaded.executed_by_monteur = False
    loaded.executed_by_helper = False
    checked.clear()
    service._draw_common_fields(commands, loaded, None, loaded.entries[0], 1, 1)
    assert not {
        CHECKBOX_CENTERS["lead_monteur"],
        CHECKBOX_CENTERS["monteur"],
        CHECKBOX_CENTERS["helper"],
        CHECKBOX_CENTERS["executor_other"],
    } & set(checked)


def test_pdf_cache_hash_changes_for_new_ticket_and_surcharge_fields():
    db = db_session()
    site = Site(site_number="9999", name="Testprojekt")
    ticket = ExtraWorkTicket(
        site=site,
        sequence_number=1,
        display_number="9999.SZ01",
        kind="billing",
        status="draft",
    )
    entry = ExtraWorkTicketEntry(
        ticket=ticket,
        site=site,
        component="",
        floor="",
        worker_rows=[{"worker_name": "Max", "monday_hours": 1}],
    )
    db.add_all([ticket, entry])
    db.commit()
    service = ExtraWorkPdfService(db)
    loaded = service._get_ticket(ticket.id, site.id)

    initial = service._build_ticket_pdf_version_hash(loaded, None)
    loaded.work_description = "Neue Beschreibung"
    ticket_field_changed = service._build_ticket_pdf_version_hash(loaded, None)
    loaded.entries[0].worker_rows = [
        {
            "worker_name": "Max",
            "monday_hours": 1,
            "monday_surcharge_25_hours": 2,
        }
    ]
    surcharge_changed = service._build_ticket_pdf_version_hash(loaded, None)
    loaded.worker_signature_place = "Bad Rothenfelde"
    loaded.worker_signature_date = date(2026, 8, 19)
    signature_details_changed = service._build_ticket_pdf_version_hash(loaded, None)

    assert initial != ticket_field_changed
    assert ticket_field_changed != surcharge_changed
    assert surcharge_changed != signature_details_changed


def test_worker_signature_place_date_and_vector_strokes_render_on_clean_pdf():
    db = db_session()
    site = Site(site_number="8015", name="Projekt", city="Fallbackstadt")
    ticket = ExtraWorkTicket(
        site=site,
        sequence_number=1,
        display_number="8015.SZ01",
        kind="billing",
        status="draft",
        worker_signature_name="Max Monteur",
        worker_signature_place="Bad Rothenfelde",
        worker_signature_date=date(2026, 8, 19),
        worker_signature_strokes=[[
            {"x": 0.1, "y": 0.2},
            {"x": 0.35, "y": 0.75},
            {"x": 0.8, "y": 0.35},
        ]],
        worker_signed_at=datetime(2026, 8, 19, 10, 30, tzinfo=timezone.utc),
    )
    db.add(ticket)
    db.commit()

    rendered, _filename = ExtraWorkPdfService(db).build_site_ticket_pdf(
        site_id=site.id,
        ticket_id=ticket.id,
    )
    reader = PdfReader(BytesIO(rendered))
    text = "\n".join(page.extract_text() or "" for page in reader.pages)

    _assert_non_interactive(reader, rendered)
    assert "Bad Rothenfelde" in text
    assert "19.08.2026" in text
    assert "Fallbackstadt" not in text


def test_approval_pdf_keeps_created_approval_date_separate_from_manual_order_date():
    db = db_session()
    site = Site(site_number="8015", name="Projekt", city="Hamburg")
    office = User(
        username="approval-pdf",
        display_name="Büro PDF",
        password_hash="x",
        role=UserRole.OFFICE,
        office_page_permissions=["sites"],
    )
    ticket = ExtraWorkTicket(
        site=site,
        sequence_number=1,
        display_number="8015.SZ01",
        kind="approval",
        status="draft",
        created_by=office,
        manual_order_date=date(2026, 8, 4),
    )
    db.add(ticket)
    db.flush()
    ticket.created_at = datetime(2026, 8, 19, 10, 0, tzinfo=timezone.utc)
    db.commit()

    content, _filename = ExtraWorkPdfService(db).build_site_ticket_pdf(
        site_id=site.id,
        ticket_id=ticket.id,
    )
    text = "\n".join(
        page.extract_text() or "" for page in PdfReader(BytesIO(content)).pages
    )

    assert "04.08.2026" in text
    assert "19.08.2026" in text


def test_more_than_three_workers_render_on_independent_template_pages():
    db = db_session()
    site = Site(site_number="9999", name="Mehrseitiges Testprojekt")
    ticket = ExtraWorkTicket(
        site=site,
        sequence_number=1,
        display_number="9999.SZ01",
        kind="billing",
        status="draft",
    )
    entry = ExtraWorkTicketEntry(
        ticket=ticket,
        site=site,
        component="",
        floor="",
        worker_rows=[
            {"worker_name": "Monteur Eins", "monday_hours": 1},
            {"worker_name": "Monteur Zwei", "tuesday_hours": 2},
            {"worker_name": "Monteur Drei", "wednesday_hours": 3},
            {"worker_name": "Monteur Vier", "thursday_hours": 4},
        ],
    )
    db.add_all([ticket, entry])
    db.commit()

    rendered, _filename = ExtraWorkPdfService(db).build_site_ticket_pdf(
        site_id=site.id,
        ticket_id=ticket.id,
    )
    reader = PdfReader(BytesIO(rendered))

    assert len(reader.pages) == 2
    first_text = reader.pages[0].extract_text() or ""
    second_text = reader.pages[1].extract_text() or ""
    assert "Monteur Eins" in first_text
    assert "Monteur Zwei" in first_text
    assert "Monteur Drei" in first_text
    assert "Monteur Vier" not in first_text
    assert "Monteur Vier" in second_text
    assert "Monteur Eins" not in second_text
    assert reader.pages[0]["/Contents"] != reader.pages[1]["/Contents"]
