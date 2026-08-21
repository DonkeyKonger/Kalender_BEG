from datetime import datetime, timezone
from io import BytesIO

from PIL import Image
from pypdf import PdfReader

from app.services.photo_appendix_pdf_service import (
    PhotoAppendixContext,
    PhotoAppendixPdfService,
    PhotoAppendixPhoto,
    _prepare_photo,
    normalize_photo_caption,
)


def _image_bytes(width: int, height: int, color: tuple[int, int, int]) -> bytes:
    image = Image.new("RGB", (width, height), color)
    output = BytesIO()
    image.save(output, format="JPEG", quality=92)
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
        monteur="Christopher Monteur",
    )


def _text(content: bytes) -> str:
    reader = PdfReader(BytesIO(content))
    return "\n".join(page.extract_text() or "" for page in reader.pages)


def test_photo_appendix_renders_landscape_caption_and_professional_document_structure():
    content = PhotoAppendixPdfService().build(
        context=_context(),
        photos=[
            PhotoAppendixPhoto(
                filename="260821_Testbaustelle_Finienweg_ZusatzauftragSZ08_Christopher_Monteur.jpg",
                content=_image_bytes(1600, 700, (185, 192, 200)),
                caption="2. OG - zusätzliche Kabelrinne im Flur Süd",
                uploaded_at=datetime(2026, 8, 21, 12, 35, tzinfo=timezone.utc),
                monteur="Christopher Monteur",
            )
        ],
    )
    reader = PdfReader(BytesIO(content))
    text = _text(content)

    assert len(reader.pages) == 1
    assert reader.pages[0].mediabox.width == 595.2756
    assert reader.pages[0].mediabox.height == 841.8898
    assert "Fotoanlage" in text
    assert "Zusatzauftrag Nr.:" in text
    assert "Vorgangsnummer" not in text
    assert "Beschriftung" in text
    assert "2. OG - zusätzliche Kabelrinne im Flur Süd" in text
    assert "BEG - Abrechnungsdokumentation" in text


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
            monteur="Christopher Monteur",
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
