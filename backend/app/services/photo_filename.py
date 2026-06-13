from __future__ import annotations

import re
from datetime import datetime
from pathlib import PurePath
from zoneinfo import ZoneInfo

PHOTO_FILENAME_TIMEZONE = ZoneInfo("Europe/Berlin")
PHOTO_CONTENT_TYPE_EXTENSIONS = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/heic": ".heic",
    "image/heif": ".heif",
}
PHOTO_UPLOAD_FOLDER_KEY = "fotos"
FORBIDDEN_FILENAME_CHARS = r'[/\\:*?"<>|]+'


def build_photo_filename(
    *,
    date: datetime | None = None,
    site_name: str | None,
    document_label: str | None = None,
    creator_name: str | None,
    extension: str | None,
    existing_names: set[str] | list[str] | tuple[str, ...] | None = None,
) -> str:
    captured_at = date or datetime.now(PHOTO_FILENAME_TIMEZONE)
    date_prefix = captured_at.astimezone(PHOTO_FILENAME_TIMEZONE).strftime("%y%m%d")
    parts = [
        date_prefix,
        sanitize_photo_filename_part(site_name, fallback="Baustelle"),
        sanitize_photo_filename_part(document_label, fallback=""),
        sanitize_photo_filename_part(creator_name, fallback="Unbekannt"),
    ]
    stem = "_".join(part for part in parts if part)
    return unique_photo_filename(stem=stem, extension=normalize_photo_extension(extension), existing_names=existing_names)


def photo_extension_from_upload(*, filename: str | None, content_type: str | None) -> str:
    normalized_content_type = (content_type or "").split(";", 1)[0].strip().lower()
    content_type_extension = PHOTO_CONTENT_TYPE_EXTENSIONS.get(normalized_content_type)
    if content_type_extension:
        return content_type_extension

    suffix = PurePath((filename or "").replace("\\", "/")).suffix.lower()
    if suffix in {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"}:
        return ".jpg" if suffix == ".jpeg" else suffix
    return ".jpg"


def is_supported_photo_upload(*, filename: str | None, content_type: str | None) -> bool:
    normalized_content_type = (content_type or "").split(";", 1)[0].strip().lower()
    if normalized_content_type in PHOTO_CONTENT_TYPE_EXTENSIONS:
        return True
    suffix = PurePath((filename or "").replace("\\", "/")).suffix.lower()
    return suffix in {".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"}


def user_photo_name(user) -> str:
    person = getattr(user, "person", None)
    return (
        getattr(person, "display_name", None)
        or getattr(user, "display_name", None)
        or getattr(user, "username", None)
        or f"user-{getattr(user, 'id', 'unbekannt')}"
    )


def measurement_photo_document_label(batch) -> str:
    number = getattr(batch, "number", None)
    return f"Aufmaß{number}" if number is not None else "Aufmaß"


def extra_work_photo_document_label(ticket) -> str:
    display_number = str(getattr(ticket, "display_number", "") or getattr(ticket, "id", "") or "").strip()
    site = getattr(ticket, "site", None)
    site_number = str(getattr(site, "site_number", "") or "").strip()
    if site_number and display_number.startswith(f"{site_number}."):
        display_number = display_number[len(site_number) + 1 :]
    display_number = display_number or "ohneNummer"
    return f"Zusatzauftrag{display_number}"


def sanitize_photo_filename_part(value: str | None, *, fallback: str) -> str:
    cleaned = (value or "").strip()
    if not cleaned:
        return fallback
    cleaned = re.sub(FORBIDDEN_FILENAME_CHARS, " ", cleaned)
    cleaned = cleaned.replace(".", " ")
    cleaned = re.sub(r"\s+", "_", cleaned)
    cleaned = re.sub(r"_+", "_", cleaned)
    cleaned = cleaned.strip("_ ")
    return cleaned[:80] or fallback


def unique_photo_filename(
    *,
    stem: str,
    extension: str,
    existing_names: set[str] | list[str] | tuple[str, ...] | None,
) -> str:
    normalized_existing = {name.lower() for name in (existing_names or [])}
    candidate = f"{stem}{extension}"
    if candidate.lower() not in normalized_existing:
        return candidate
    for index in range(2, 1000):
        candidate = f"{stem}_{index:02d}{extension}"
        if candidate.lower() not in normalized_existing:
            return candidate
    return f"{stem}_{datetime.now(PHOTO_FILENAME_TIMEZONE).strftime('%H%M%S')}{extension}"


def normalize_photo_extension(extension: str | None) -> str:
    cleaned = (extension or ".jpg").strip().lower()
    if not cleaned.startswith("."):
        cleaned = f".{cleaned}"
    if cleaned == ".jpeg":
        return ".jpg"
    if cleaned in {".jpg", ".png", ".webp", ".heic", ".heif"}:
        return cleaned
    return ".jpg"
