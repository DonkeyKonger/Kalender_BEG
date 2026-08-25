from dataclasses import replace
from datetime import datetime, timezone
from io import BytesIO
from types import SimpleNamespace

import pytest
from PIL import Image, ImageDraw
from pypdf import PdfReader, PdfWriter

from app.models.enums import UserRole
from app.services import extra_work_pdf_service as extra_work_pdf_module
from app.services import measurement_pdf_service as measurement_pdf_module
from app.services.extra_work_pdf_service import ExtraWorkPdfService
from app.services.measurement_pdf_service import MeasurementPdfService, SimplePdf

from app.services.photo_appendix_pdf_service import (
    COMPACT_LOGO_MAX_HEIGHT,
    COMPACT_LOGO_MAX_WIDTH,
    COMPACT_LOGO_SCALE_FACTOR,
    PDF_IMAGE_DPI,
    PhotoAppendixContext,
    PhotoAppendixPdfService,
    PhotoAppendixPhoto,
    _prepare_photo,
    _prepare_information_block,
    _pdf_image_target_size,
    normalize_photo_caption,
)
from app.services.user_display import user_document_attribution


def _image_bytes(width: int, height: int, color: tuple[int, int, int]) -> bytes:
    image = Image.new("RGB", (width, height), color)
    output = BytesIO()
    image.save(output, format="JPEG", quality=92)
    return output.getvalue()


def _png_screenshot_bytes(width: int = 2048, height: int = 2732) -> bytes:
    image = Image.new("RGB", (width, height), (246, 248, 251))
    draw = ImageDraw.Draw(image)
    for row in range(12):
        top = 80 + row * 190
        draw.rectangle((90, top, width - 90, top + 140), fill=(255, 255, 255))
        draw.line((180, top + 45, width - 180, top + 45), fill=(20, 42, 82), width=6)
    output = BytesIO()
    image.save(output, format="PNG", optimize=True)
    return output.getvalue()


def _exif_rotated_jpeg_bytes() -> bytes:
    image = Image.new("RGB", (1600, 900), (80, 100, 120))
    exif = Image.Exif()
    exif[274] = 6
    output = BytesIO()
    image.save(output, format="JPEG", quality=92, exif=exif)
    return output.getvalue()


def _gif_bytes() -> bytes:
    image = Image.new("P", (900, 600), 1)
    output = BytesIO()
    image.save(output, format="GIF")
    return output.getvalue()


def _context(document_type: str = "Zusatzauftrag") -> PhotoAppendixContext:
    return PhotoAppendixContext(
        document_type=document_type,
        site_name="Testbaustelle Finienweg",
        site_number="9999",
        site_address="Finienweg 10, 28832 Achim",
        process_title="Zusatzarbeiten",
        document_number_label="Zusatzauftrag Nr.",
        document_number="9999.SZ08",
        generated_at=datetime(2026, 8, 21, 12, 35, tzinfo=timezone.utc),
        uploaded_at=datetime(2026, 8, 21, 12, 35, tzinfo=timezone.utc),
        creator_name="Christopher Ehrichsen",
        creator_role_label="Projektleiter",
    )


def _text(content: bytes) -> str:
    reader = PdfReader(BytesIO(content))
    return "\n".join(page.extract_text() or "" for page in reader.pages)


def test_photo_appendix_renders_landscape_caption_and_professional_document_structure():
    content = PhotoAppendixPdfService().build(
        context=_context(),
        photos=[
            PhotoAppendixPhoto(
                filename="260821_Testbaustelle_Finienweg_ZusatzauftragSZ08_Christopher_Ehrichsen.jpg",
                content=_image_bytes(1600, 700, (185, 192, 200)),
                caption="2. OG - zusätzliche Kabelrinne im Flur Süd",
                uploaded_at=datetime(2026, 8, 21, 12, 35, tzinfo=timezone.utc),
                creator_name="Christopher Ehrichsen",
                creator_role_label="Projektleiter",
            )
        ],
    )
    reader = PdfReader(BytesIO(content))
    text = _text(content)

    assert len(reader.pages) == 1
    assert reader.pages[0].mediabox.width == 595.2756
    assert reader.pages[0].mediabox.height == 841.8898
    assert "Fotoanlage" in text
    assert "21.08.2026, 14:35" in text
    assert "Zusatzauftrag Nr.:" in text
    assert "Vorgangsnummer" not in text
    assert "Beschriftung" in text
    assert "2. OG - zusätzliche Kabelrinne im Flur Süd" in text
    assert "BEG - Abrechnungsdokumentation" in text
    assert text.count("Hochgeladen am") == 1
    assert text.count("21.08.2026, 14:35") == 2
    assert text.count("Projektleiter") == 2
    assert "Monteur" not in text
    assert b"/ASCII85Decode" not in content
    assert b"/DCTDecode" in content


def test_photo_appendix_information_block_has_three_columns_and_wraps_full_site_details():
    context = PhotoAppendixContext(
        document_type="Zusatzauftrag",
        site_name="Schüchtermann Klinik Erweiterungsbau Südflügel",
        site_number="8007",
        site_address="Ulmenallee 5, Gebäudeabschnitt Süd, 49214 Bad Rothenfelde",
        process_title="Zusatzarbeiten",
        document_number_label="Zusatzauftrag Nr.",
        document_number="8007.SZ12",
        generated_at=datetime(2026, 8, 21, 12, 35, tzinfo=timezone.utc),
        uploaded_at=datetime(2026, 8, 19, 11, 51, tzinfo=timezone.utc),
        creator_name="Christopher Ehrichsen",
        creator_role_label="Projektleiter",
    )
    layout = _prepare_information_block(context)
    content = PhotoAppendixPdfService().build(
        context=context,
        photos=[
            PhotoAppendixPhoto(
                filename="baustelle.jpg",
                content=_image_bytes(1600, 700, (185, 192, 200)),
                uploaded_at=datetime(2026, 8, 17, 10, 52, tzinfo=timezone.utc),
                creator_name="Christopher Ehrichsen",
                creator_role_label="Projektleiter",
            )
        ],
    )
    text = _text(content)
    normalized_text = " ".join(text.split())

    assert [column.label for column in layout.columns] == ["Baustelle", "Vorgang", "Projektleiter"]
    assert layout.height > 58
    assert "Hochgeladen am" not in [column.label for column in layout.columns]
    assert "Ulmenallee 5," in text
    assert "Gebäudeabschnitt Süd," in text
    assert "49214 Bad Rothenfelde" in normalized_text
    assert "…" not in text
    assert "19.08.2026, 13:51" not in text
    assert "17.08.2026, 12:52" in text


@pytest.mark.parametrize(
    ("role", "expected_label"),
    [
        (UserRole.PROJECT_MANAGER, "Projektleiter"),
        (UserRole.MONTEUR, "Monteur"),
        (UserRole.OFFICE, "Büromitarbeiter"),
        (None, "Erstellt von"),
        ("historical_unknown", "Erstellt von"),
    ],
)
def test_photo_appendix_uses_uploader_role_for_both_visible_creator_labels(
    role,
    expected_label,
):
    uploader = SimpleNamespace(
        role=role,
        person=SimpleNamespace(display_name="Christopher Ehrichsen"),
        display_name="Fallback Name",
    )
    attribution = user_document_attribution(uploader)
    assert attribution is not None
    context = replace(
        _context(),
        creator_name=attribution.name,
        creator_role_label=attribution.role_label,
    )
    content = PhotoAppendixPdfService().build(
        context=context,
        photos=[PhotoAppendixPhoto(
            filename="rollenpruefung.jpg",
            content=_image_bytes(1200, 800, (80, 100, 120)),
            uploaded_at=datetime(2026, 8, 21, 12, 35, tzinfo=timezone.utc),
            creator_name=attribution.name,
            creator_role_label=attribution.role_label,
        )],
    )
    text = _text(content)

    assert text.count(expected_label) == 2
    assert text.count("Christopher Ehrichsen") == 2
    if expected_label != "Monteur":
        assert "Monteur" not in text


def test_photo_appendix_omits_empty_caption_blocks_for_none_whitespace_and_newlines():
    for caption in (None, "", "   ", "\n\n"):
        content = PhotoAppendixPdfService().build(
            context=_context("Aufmaß"),
            photos=[
                PhotoAppendixPhoto(
                    filename="altes-foto.jpg",
                    content=_image_bytes(1200, 800, (220, 220, 220)),
                    caption=caption,
                )
            ],
        )
        assert "Beschriftung" not in _text(content)
    assert normalize_photo_caption("  Dokumentation\n  ") == "Dokumentation"


def test_photo_appendix_preserves_landscape_and_portrait_aspect_ratios():
    landscape = _prepare_photo(
        PhotoAppendixPhoto(filename="quer.jpg", content=_image_bytes(1600, 800, (20, 40, 80)))
    )
    portrait = _prepare_photo(
        PhotoAppendixPhoto(filename="hoch.jpg", content=_image_bytes(700, 1500, (80, 40, 20)))
    )

    assert landscape.aspect_ratio == 2
    assert round(portrait.aspect_ratio, 2) == 0.47
    assert landscape.desired_image_height < portrait.desired_image_height


def test_photo_appendix_sizes_work_images_for_pdf_dpi_without_upscaling():
    landscape = _prepare_photo(
        PhotoAppendixPhoto(filename="quer.jpg", content=_image_bytes(4032, 3024, (20, 40, 80)))
    )
    small = _prepare_photo(
        PhotoAppendixPhoto(filename="klein.jpg", content=_image_bytes(640, 480, (80, 40, 20)))
    )

    assert PDF_IMAGE_DPI == 160
    assert _pdf_image_target_size(390) == (1172, 867)
    assert (landscape.width, landscape.height) == (1156, 867)
    assert (small.width, small.height) == (640, 480)


def test_photo_appendix_keeps_png_work_image_lossless():
    source = _png_screenshot_bytes()
    prepared = _prepare_photo(PhotoAppendixPhoto(filename="screenshot.png", content=source))

    assert prepared.error is None
    assert prepared.image_data is not None
    assert prepared.image_data.startswith(b"\x89PNG\r\n\x1a\n")
    assert prepared.height <= 912


def test_photo_appendix_normalizes_exif_orientation_before_sizing():
    source = _exif_rotated_jpeg_bytes()
    original = bytes(source)
    prepared = _prepare_photo(PhotoAppendixPhoto(filename="smartphone.jpg", content=source))

    assert prepared.error is None
    assert prepared.height > prepared.width
    assert (prepared.width, prepared.height) == (513, 912)
    assert source == original


def test_photo_appendix_converts_supported_gif_to_jpeg_work_image():
    prepared = _prepare_photo(PhotoAppendixPhoto(filename="dokumentation.gif", content=_gif_bytes()))

    assert prepared.error is None
    assert prepared.image_data is not None
    assert prepared.image_data.startswith(b"\xff\xd8\xff")


def test_photo_appendix_compact_header_logo_is_twenty_percent_larger():
    assert COMPACT_LOGO_SCALE_FACTOR == 1.2
    assert COMPACT_LOGO_MAX_WIDTH == 67.2
    assert COMPACT_LOGO_MAX_HEIGHT == 48


def test_photo_appendix_handles_five_mixed_photos_long_caption_and_long_filename():
    photos = [
        PhotoAppendixPhoto(
            filename=("sehr_langer_technischer_dateiname_" * 6) + f"{index}.jpg",
            content=_image_bytes(1500 if index % 2 else 700, 700 if index % 2 else 1500, (40 * index, 70, 100)),
            caption=(
                "Ausführliche mehrzeilige Dokumentation der ausgeführten Montagearbeiten "
                "mit Lage, Ausführung und technischem Bezug. " * 3
            ) if index in {1, 4} else None,
            uploaded_at=datetime(2026, 8, 21, 12, 30 + index, tzinfo=timezone.utc),
            creator_name="Christopher Ehrichsen",
            creator_role_label="Projektleiter",
        )
        for index in range(1, 6)
    ]
    content = PhotoAppendixPdfService().build(context=_context(), photos=photos)
    reader = PdfReader(BytesIO(content))
    text = _text(content)

    assert len(reader.pages) >= 3
    assert "Foto 5 von 5" in text
    assert text.count("BEG - Abrechnungsdokumentation") == len(reader.pages)
    assert "null" not in text
    assert "undefined" not in text


def test_photo_appendix_keeps_document_alive_when_one_image_cannot_be_decoded():
    content = PhotoAppendixPdfService().build(
        context=_context("Projekt"),
        photos=[PhotoAppendixPhoto(filename="defekt.jpg", content=b"not-an-image")],
    )

    assert "Foto konnte nicht dargestellt werden." in _text(content)


def test_extra_work_caller_uses_shared_photo_appendix(monkeypatch):
    uploaded_at = datetime(2026, 8, 21, 12, 35, tzinfo=timezone.utc)
    uploader = SimpleNamespace(
        role=UserRole.PROJECT_MANAGER,
        person=SimpleNamespace(display_name="Christopher Ehrichsen"),
        display_name="Christopher Ehrichsen",
    )
    photo = SimpleNamespace(
        id=1,
        created_at=uploaded_at,
        external_drive_id="drive-1",
        external_item_id="photo-1",
        filename="zusatzauftrag.jpg",
        caption="Zusätzliche Kabelrinne montiert",
        uploaded_by=uploader,
    )
    site = SimpleNamespace(
        name="Testbaustelle Finienweg",
        site_number="9999",
        street="Finienweg",
        house_number="10",
        postal_code="28832",
        city="Achim",
    )
    ticket = SimpleNamespace(
        id=8,
        site_id=9,
        site=site,
        photos=[photo],
        title="Zusatzarbeiten",
        display_number="9999.SZ08",
        sequence_number=8,
    )

    class FakeStorage:
        def download_file_from_folder(self, **_kwargs):
            return {"content": _image_bytes(1600, 700, (185, 192, 200))}

    monkeypatch.setattr(extra_work_pdf_module, "ProjectStorageService", FakeStorage)
    service = ExtraWorkPdfService(SimpleNamespace())
    monkeypatch.setattr(service, "_get_photo_folder_item_id", lambda _site_id: "folder-1")
    writer = PdfWriter()
    writer.add_blank_page(width=595, height=842)

    service._append_photo_pages(writer, ticket)
    output = BytesIO()
    writer.write(output)
    reader = PdfReader(BytesIO(output.getvalue()))
    appendix_text = reader.pages[1].extract_text() or ""

    assert len(reader.pages) == 2
    assert "Fotoanlage" in appendix_text
    assert "Zusatzauftrag Nr.:" in appendix_text
    assert "Zusätzliche Kabelrinne montiert" in appendix_text
    assert appendix_text.count("Projektleiter") == 2
    assert "Monteur" not in appendix_text


def test_measurement_caller_uses_shared_photo_appendix(monkeypatch):
    uploaded_at = datetime(2026, 8, 21, 12, 35, tzinfo=timezone.utc)
    uploader = SimpleNamespace(
        role=UserRole.OFFICE,
        person=SimpleNamespace(display_name="Büro Test"),
        display_name="Büro Test",
    )
    photo = SimpleNamespace(
        id=2,
        created_at=uploaded_at,
        external_drive_id="drive-1",
        external_item_id="photo-2",
        filename="aufmass.jpg",
        caption="Deckendurchbruch dokumentiert",
        uploaded_by=uploader,
    )
    site = SimpleNamespace(
        name="Testbaustelle Finienweg",
        site_number="9999",
        street="Finienweg",
        house_number="10",
        postal_code="28832",
        city="Achim",
        address=None,
        location=None,
    )
    batch = SimpleNamespace(id=4, site_id=9, site=site, photos=[photo], title="Aufmaß Technikraum", number=4)

    class FakeStorage:
        def download_file_from_folder(self, **_kwargs):
            return {"content": _image_bytes(700, 1500, (185, 192, 200))}

    monkeypatch.setattr(measurement_pdf_module, "ProjectStorageService", FakeStorage)
    service = MeasurementPdfService(SimpleNamespace())
    monkeypatch.setattr(service, "_get_photo_folder_item_id", lambda _site_id: "folder-1")
    base_pdf = SimplePdf()
    base_pdf.add_page([])

    content = service._append_photo_pages(base_pdf.build(), batch)
    reader = PdfReader(BytesIO(content))
    appendix_text = reader.pages[1].extract_text() or ""

    assert len(reader.pages) == 2
    assert "Fotoanlage" in appendix_text
    assert "Aufmaß Nr.:" in appendix_text
    assert "Deckendurchbruch dokumentiert" in appendix_text
    assert appendix_text.count("Büromitarbeiter") == 2
