from io import BytesIO

from PIL import Image

from app.services.document_photo_optimizer import (
    DOCUMENT_PHOTO_THUMBNAIL_SIZE,
    create_document_photo_thumbnail,
)


def test_document_photo_thumbnail_is_small_square_jpeg() -> None:
    source = BytesIO()
    Image.new("RGB", (1600, 900), "#1f4f88").save(source, format="PNG")

    thumbnail = create_document_photo_thumbnail(source.getvalue())

    with Image.open(BytesIO(thumbnail)) as image:
        assert image.format == "JPEG"
        assert image.size == (
            DOCUMENT_PHOTO_THUMBNAIL_SIZE,
            DOCUMENT_PHOTO_THUMBNAIL_SIZE,
        )
    assert len(thumbnail) < len(source.getvalue())
