from __future__ import annotations

from hashlib import sha256
from io import BytesIO
from pathlib import Path
from typing import Any

import pdfplumber
from PIL import Image, ImageOps

from app.core.config import settings

THUMBNAIL_SIZE_PX = 220
THUMBNAIL_RENDER_RESOLUTION = 96
THUMBNAIL_QUALITY = 78
THUMBNAIL_MEDIA_TYPE = "image/jpeg"


class PdfThumbnailUnavailableError(Exception):
    """Raised when a PDF thumbnail cannot be generated safely."""


class DocumentThumbnailService:
    def __init__(self, cache_dir: str | Path | None = None) -> None:
        self.cache_dir = Path(cache_dir or settings.document_thumbnail_cache_dir)

    def cache_path(self, cache_key: str) -> Path:
        return self.cache_dir / f"{cache_key}.jpg"

    def get_cached_thumbnail(self, cache_key: str) -> Path | None:
        path = self.cache_path(cache_key)
        if path.exists() and path.stat().st_size > 0:
            return path
        return None

    def get_or_create_pdf_thumbnail(self, pdf_content: bytes, cache_key: str) -> Path:
        cached = self.get_cached_thumbnail(cache_key)
        if cached:
            return cached

        thumbnail = self._render_first_page(pdf_content)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        path = self.cache_path(cache_key)
        temporary_path = path.with_suffix(".tmp")
        thumbnail.save(temporary_path, format="JPEG", quality=THUMBNAIL_QUALITY, optimize=True)
        temporary_path.replace(path)
        return path

    def build_cache_key(
        self,
        *,
        site_id: int,
        folder_key: str,
        drive_id: str | None,
        item_id: str,
        document: dict[str, Any],
    ) -> str:
        identity = "|".join(
            [
                str(site_id),
                folder_key,
                drive_id or "",
                item_id,
                str(document.get("name") or ""),
                str(document.get("last_modified_date_time") or ""),
                str(document.get("size") or ""),
            ]
        )
        return sha256(identity.encode("utf-8")).hexdigest()

    def _render_first_page(self, pdf_content: bytes) -> Image.Image:
        try:
            with pdfplumber.open(BytesIO(pdf_content)) as pdf:
                if not pdf.pages:
                    raise PdfThumbnailUnavailableError("PDF enthält keine Seiten.")
                rendered = pdf.pages[0].to_image(
                    resolution=THUMBNAIL_RENDER_RESOLUTION,
                    antialias=True,
                ).original
        except PdfThumbnailUnavailableError:
            raise
        except Exception as error:
            raise PdfThumbnailUnavailableError("PDF-Vorschau konnte nicht erzeugt werden.") from error

        image = rendered.convert("RGB")
        thumbnail = ImageOps.contain(
            image,
            (THUMBNAIL_SIZE_PX, THUMBNAIL_SIZE_PX),
            method=Image.Resampling.LANCZOS,
        )
        canvas = Image.new("RGB", (THUMBNAIL_SIZE_PX, THUMBNAIL_SIZE_PX), "#ffffff")
        offset = (
            (THUMBNAIL_SIZE_PX - thumbnail.width) // 2,
            (THUMBNAIL_SIZE_PX - thumbnail.height) // 2,
        )
        canvas.paste(thumbnail, offset)
        return canvas


def is_pdf_document(document: dict[str, Any]) -> bool:
    extension = str(document.get("file_extension") or "").lower()
    mime_type = str(document.get("mime_type") or "").lower()
    name = str(document.get("name") or "").lower()
    return extension == "pdf" or mime_type == "application/pdf" or name.endswith(".pdf")
