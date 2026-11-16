"""One public filename for each document, independent of delivery channel."""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from datetime import date
import re
import unicodedata

from app.services.document_dates import extra_work_document_date, measurement_document_date
from app.services.extra_work_number import parse_extra_work_sequence


def _component(value: object, fallback: str) -> str:
    text = unicodedata.normalize("NFC", str(value or ""))
    text = re.sub(r'[<>:"/\\|?*\x00-\x1f\x7f\s]+', "_", text)
    text = re.sub(r"_+", "_", text).strip("._ ")
    return text or fallback


def _filename(number: str, document_date: date | None, site_name: str, *, status: str) -> str:
    # A draft has no submission day yet. Unknown historical event dates must not
    # silently become the creation, last-edit, or download date.
    date_part = document_date.strftime("%y%m%d") if document_date else (
        "Entwurf" if status in {"draft", "rejected"} else "ohne_Datum"
    )
    stem = f"{_component(number, 'Dokument')}_{date_part}_{_component(site_name, 'Baustelle')}"
    # Keep space for suffixes (e.g. the separate photo annex) on common filesystems.
    stem = stem.encode("utf-8")[:220].decode("utf-8", errors="ignore").rstrip("._ ")
    return f"{stem}.pdf"


def measurement_filename(batch) -> str:
    site = batch.site
    site_number = _component(site.site_number, f"Baustelle_{batch.site_id}")
    return _filename(
        f"{site_number}.{batch.number:02d}",
        measurement_document_date(batch),
        site.name,
        status=batch.status,
    )


def extra_work_filename(ticket) -> str:
    site = ticket.site
    site_number = _component(site.site_number, f"Baustelle_{ticket.site_id}")
    # Preserve the issued running number, including legacy .SZ03 documents;
    # only the filename prefix is normalized to .Z03.
    sequence = parse_extra_work_sequence(ticket.display_number, site_number=site.site_number)
    if sequence is None:
        sequence = ticket.sequence_number
    return _filename(
        f"{site_number}.Z{sequence:02d}",
        extra_work_document_date(ticket),
        site.name,
        status=ticket.status,
    )


def measurement_group_filename(group, batches: Iterable | Mapping) -> str:
    """A combined document inherits its leading source's number and event day."""
    sources = list(batches.values() if isinstance(batches, Mapping) else batches)
    if not sources:
        raise ValueError("A combined measurement requires source batches.")
    leading = max(sources, key=lambda batch: (batch.number, batch.id))
    return _filename(
        group.number_label,
        measurement_document_date(leading),
        leading.site.name,
        status=leading.status,
    )
