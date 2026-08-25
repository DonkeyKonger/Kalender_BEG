from datetime import date, datetime, timezone
from io import BytesIO
from hashlib import sha256
import re

from fastapi import HTTPException
import pytest
from pypdf import PdfReader
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.models import Base
from app.models.assignment import Assignment
from app.models.enums import UserRole
from app.models.extra_work_ticket import ExtraWorkTicket, ExtraWorkTicketEntry, ExtraWorkTicketPhoto
from app.models.person import Person
from app.models.site import Site
from app.models.user import User
from app.services import extra_work_pdf_service as pdf_module
from app.services.extra_work_pdf_service import (
    CHECKBOX_CENTERS,
    ExtraWorkPdfService,
    OverlayPdf,
)
from app.services.extra_work_remarks import (
    EXTRA_WORK_REMARKS_FONT_SIZE,
    EXTRA_WORK_REMARKS_INNER_WIDTH,
    EXTRA_WORK_REMARKS_LINE_HEIGHT,
    EXTRA_WORK_REMARKS_MAX_LINES,
    extra_work_remarks_fit,
    extra_work_remarks_width,
    wrap_extra_work_remarks,
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


def _repeated_word_at_remarks_capacity(word: str = "Test") -> str:
    words: list[str] = []
    while extra_work_remarks_fit(" ".join([*words, word])):
        words.append(word)
    return " ".join(words)


def test_signed_snapshot_binds_manifest_and_pdf_to_the_same_original_bytes(monkeypatch):
    db = db_session()
    site = Site(site_number="9999", name="Snapshot Baustelle")
    ticket = ExtraWorkTicket(
        site=site,
        sequence_number=1,
        display_number="9999.Z01",
        kind="billing",
        status="signed",
        customer_signed_at=datetime(2026, 8, 25, tzinfo=timezone.utc),
    )
    photo = ExtraWorkTicketPhoto(
        site=site,
        ticket=ticket,
        project_folder_key="fotos",
        external_drive_id="drive",
        external_item_id="item",
        filename="beweisfoto.jpg",
        content_type="image/jpeg",
    )
    db.add_all([site, ticket, photo])
    db.commit()
    original_bytes = b"original-photo-bytes"
    manifest = [{"photo_id": photo.id, "order": 1, "content_sha256": sha256(original_bytes).hexdigest()}]
    captured = {}
    service = ExtraWorkPdfService(db)
    monkeypatch.setattr(service, "_build_photo_manifest", lambda _ticket, _photos: (manifest, {photo.id: original_bytes}))

    def fake_build_ticket_pdf(**kwargs):
        captured.update(kwargs)
        return b"%PDF-signed-snapshot"

    monkeypatch.setattr(service, "_build_ticket_pdf", fake_build_ticket_pdf)
    content, _filename = service.create_signed_snapshot(ticket=ticket, assignment=None, photos=[photo])

    assert content == b"%PDF-signed-snapshot"
    assert captured["photo_contents"] == {photo.id: original_bytes}
    assert ticket.signed_photo_manifest["photos"] == manifest
    assert ticket.signed_pdf_sha256 == sha256(content).hexdigest()


def test_remarks_capacity_uses_all_18_real_pdf_lines_with_exact_helvetica_metrics():
    value = _repeated_word_at_remarks_capacity()
    lines = wrap_extra_work_remarks(value)

    assert EXTRA_WORK_REMARKS_MAX_LINES == 18
    assert len(lines) == EXTRA_WORK_REMARKS_MAX_LINES
    assert all(extra_work_remarks_width(line) <= EXTRA_WORK_REMARKS_INNER_WIDTH for line in lines)
    assert extra_work_remarks_fit(value)
    assert not extra_work_remarks_fit(f"{value} Test")

    commands: list[bytes] = []
    pdf_module._remarks_textarea(commands, pdf_module.FIELD_RECTS["BemerkungenRow1"], value)
    assert len(commands) == EXTRA_WORK_REMARKS_MAX_LINES
    final_baseline = float(re.search(rb" ([0-9.]+) Td ", commands[-1]).group(1))
    rect = pdf_module.FIELD_RECTS["BemerkungenRow1"]
    bottom_edge = pdf_module.PAGE_HEIGHT - rect.y - rect.height
    assert final_baseline >= bottom_edge + 2
    assert final_baseline - EXTRA_WORK_REMARKS_LINE_HEIGHT < bottom_edge + 2
    assert f"/F1 {EXTRA_WORK_REMARKS_FONT_SIZE:g} Tf".encode() in commands[-1]


def test_remarks_wrap_handles_manual_breaks_long_words_and_character_widths():
    assert extra_work_remarks_fit("\n".join(["Zeile"] * 18))
    assert not extra_work_remarks_fit("\n".join(["Zeile"] * 19))

    long_word_lines = wrap_extra_work_remarks("W" * 400)
    assert "".join(long_word_lines) == "W" * 400
    assert all(extra_work_remarks_width(line) <= EXTRA_WORK_REMARKS_INNER_WIDTH for line in long_word_lines)
    assert extra_work_remarks_width("Test") == 14.5875
    assert extra_work_remarks_width("ÄÖÜ äöü ß €") == 43.77
    assert len(wrap_extra_work_remarks("W" * 120)) > len(wrap_extra_work_remarks("i" * 120))
    assert len(_repeated_word_at_remarks_capacity("i")) > len(
        _repeated_word_at_remarks_capacity("W")
    )


def test_remarks_renderer_rejects_legacy_overflow_instead_of_silently_ellipsizing():
    value = f"{_repeated_word_at_remarks_capacity()} Test"
    commands: list[bytes] = []

    with pytest.raises(HTTPException, match="gespeicherten Bemerkungen") as error:
        pdf_module._remarks_textarea(commands, pdf_module.FIELD_RECTS["BemerkungenRow1"], value)

    assert error.value.status_code == 422
    assert commands == []


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
        "2x Stiel US 5 bis 500; "
        "2,5 m Kabelrinne; "
        "Kleinmaterial Befestigung"
    )


def test_structured_material_formats_optional_quantity_and_unit_without_extra_spaces():
    entry = ExtraWorkTicketEntry(
        material_items=[
            {"quantity": 100, "unit": "", "description": "  Schutzkappen  "},
            {"quantity": None, "unit": "Stk", "description": "Kleinmaterial   Befestigung"},
            {"quantity": 10, "unit": " m ", "description": " RKSM 610 "},
        ],
    )

    assert pdf_module._format_extra_work_material(entry) == (
        "100 Schutzkappen; Kleinmaterial Befestigung; 10 m RKSM 610"
    )
    assert not pdf_module._format_extra_work_material(entry).endswith(";")


def test_material_wrap_uses_font_metrics_and_prefers_complete_position_boundaries():
    positions = ["2x US 5 Stiel", "100 St RGV 60", "10 m RKSM 610"]
    first_line = "2x US 5 Stiel; 100 St RGV 60;"
    width = pdf_module._pdf_font_text_width(first_line, 8) + 0.1

    assert pdf_module._pdf_font_text_width("WWWW", 8) > pdf_module._pdf_font_text_width("iiii", 8)
    assert pdf_module._wrap_material_positions(positions, width, 8) == [
        first_line,
        "10 m RKSM 610",
    ]


def test_single_long_material_position_wraps_by_words_without_clipping_or_ellipsis():
    position = (
        "10 Stk sehr langer Materialname mit zusätzlicher technischer "
        "Beschreibung für fachgerechte Montage"
    )
    lines = pdf_module._wrap_material_positions([position], 150, 8)

    assert len(lines) > 1
    assert " ".join(lines) == position
    assert all(pdf_module._pdf_font_text_width(line, 8) <= 150 for line in lines)
    assert all("..." not in line for line in lines)


def test_twenty_short_material_positions_fit_the_existing_three_line_pdf_field():
    entry = ExtraWorkTicketEntry(
        material_items=[
            {"quantity": index, "unit": "x", "description": f"M{index}"}
            for index in range(1, 21)
        ],
    )
    width = pdf_module.FIELD_RECTS["Material"].width - 4
    lines = pdf_module._wrap_extra_work_material(entry, width, 8, max_lines=3)
    expected = "; ".join(f"{index}x M{index}" for index in range(1, 21))

    assert 1 < len(lines) <= 3
    assert " ".join(lines) == expected
    assert all(pdf_module._pdf_font_text_width(line, 8) <= width for line in lines)
    assert all("..." not in line for line in lines)


def test_legacy_material_line_breaks_and_empty_material_remain_compatible():
    legacy_entry = ExtraWorkTicketEntry(
        material_text="Kabelrinne alt\nBefestiger alt",
        material_items=[{"quantity": 2, "unit": "x", "description": "Stiel neu"}],
    )
    width = pdf_module.FIELD_RECTS["Material"].width - 4

    assert pdf_module._wrap_extra_work_material(legacy_entry, width, 8, max_lines=3) == [
        "Kabelrinne alt",
        "Befestiger alt",
        "2x Stiel neu",
    ]
    assert pdf_module._format_extra_work_material(ExtraWorkTicketEntry()) == ""
    assert pdf_module._wrap_extra_work_material(ExtraWorkTicketEntry(), width, 8, 3) == []


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
        customer_name="Muster Generalunternehmer GmbH",
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
        remarks=_repeated_word_at_remarks_capacity(),
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
    assert text.split().count("Test") == entry.remarks.split().count("Test")
    _assert_non_interactive(reader, rendered)
    for value in (
        "8015",
        "8015.SZ01",
        "Muster Generalunternehmer GmbH",
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
    assert "Bredow GmbH" not in text
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


def test_legacy_ticket_without_customer_name_uses_site_customer_in_pdf():
    db = db_session()
    site = Site(site_number="9999", name="Altprojekt", customer="Firma A")
    ticket = ExtraWorkTicket(
        site=site,
        sequence_number=1,
        display_number="9999.SZ01",
        kind="billing",
        status="draft",
        customer_name=None,
    )
    db.add(ticket)
    db.commit()

    rendered, _ = ExtraWorkPdfService(db).build_site_ticket_pdf(
        site_id=site.id,
        ticket_id=ticket.id,
    )
    text = "\n".join(page.extract_text() or "" for page in PdfReader(BytesIO(rendered)).pages)

    assert "Firma A" in text


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
    loaded.customer_name = "Abweichender Kunde"
    customer_changed = service._build_ticket_pdf_version_hash(loaded, None)
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

    assert initial != customer_changed
    assert customer_changed != ticket_field_changed
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
