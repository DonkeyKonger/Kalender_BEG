from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
from time import perf_counter

from fastapi import HTTPException, status
from PIL import Image, ImageOps, UnidentifiedImageError

from app.services.photo_limits import MAX_PHOTO_DIMENSION, MAX_PHOTO_UPLOAD_BYTES, PHOTO_JPEG_QUALITY


OPTIMIZED_PHOTO_CONTENT_TYPE = "image/jpeg"


@dataclass(frozen=True)
class OptimizedDocumentPhoto:
    content: bytes
    content_type: str
    original_size_bytes: int
    optimized_size_bytes: int
    original_width: int
    original_height: int
    optimized_width: int
    optimized_height: int
    duration_ms: float


def optimize_document_photo(content: bytes) -> OptimizedDocumentPhoto:
    if not content:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Foto ist leer.")
    if len(content) > MAX_PHOTO_UPLOAD_BYTES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Foto ist zu groß.")

    started_at = perf_counter()
    try:
        with Image.open(BytesIO(content)) as source:
            image = ImageOps.exif_transpose(source)
            original_width, original_height = image.size
            if image.mode not in {"RGB", "RGBA"}:
                image = image.convert("RGBA")
            image.thumbnail((MAX_PHOTO_DIMENSION, MAX_PHOTO_DIMENSION), Image.Resampling.LANCZOS)
            rgb = Image.new("RGB", image.size, "white")
            if image.mode == "RGBA":
                rgb.paste(image, mask=image.getchannel("A"))
            else:
                rgb.paste(image)
            output = BytesIO()
            rgb.save(output, format="JPEG", quality=PHOTO_JPEG_QUALITY, optimize=True)
    except (OSError, UnidentifiedImageError, ValueError) as error:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Bitte ein gültiges Foto hochladen.") from error

    optimized = output.getvalue()
    duration_ms = (perf_counter() - started_at) * 1000
    return OptimizedDocumentPhoto(
        content=optimized,
        content_type=OPTIMIZED_PHOTO_CONTENT_TYPE,
        original_size_bytes=len(content),
        optimized_size_bytes=len(optimized),
        original_width=original_width,
        original_height=original_height,
        optimized_width=rgb.width,
        optimized_height=rgb.height,
        duration_ms=duration_ms,
    )
