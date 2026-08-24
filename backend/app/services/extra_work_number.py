from __future__ import annotations

from collections.abc import Iterable
import re


EXTRA_WORK_NUMBER_PREFIX = "Z"
EXTRA_WORK_LEGACY_NUMBER_PREFIX = "SZ"


def build_extra_work_display_number(site_number: str | None, sequence_number: int) -> str:
    """Build the canonical number used only for newly created extra-work tickets."""
    normalized_site_number = _normalize_site_number(site_number)
    if not normalized_site_number:
        raise ValueError("A site number is required for an extra-work display number.")
    if sequence_number < 1:
        raise ValueError("The extra-work sequence number must be positive.")
    return f"{normalized_site_number}.{EXTRA_WORK_NUMBER_PREFIX}{sequence_number:02d}"


def parse_extra_work_sequence(
    display_number: str | None,
    *,
    site_number: str | None,
) -> int | None:
    """Read canonical current and legacy numbers without accepting lookalike documents."""
    normalized_site_number = _normalize_site_number(site_number)
    normalized_display_number = (display_number or "").strip()
    if not normalized_site_number or not normalized_display_number:
        return None
    match = re.fullmatch(
        rf"{re.escape(normalized_site_number)}\.(?:"
        rf"{EXTRA_WORK_LEGACY_NUMBER_PREFIX}|{EXTRA_WORK_NUMBER_PREFIX}"
        rf")(0*[1-9]\d*)",
        normalized_display_number,
    )
    return int(match.group(1)) if match else None


def next_extra_work_sequence(
    *,
    site_number: str | None,
    existing_numbers: Iterable[tuple[int, str]],
) -> int:
    """Continue across stored sequence values and valid legacy/current display numbers."""
    highest_sequence = 0
    for stored_sequence, display_number in existing_numbers:
        if stored_sequence > highest_sequence:
            highest_sequence = stored_sequence
        parsed_sequence = parse_extra_work_sequence(
            display_number,
            site_number=site_number,
        )
        if parsed_sequence is not None and parsed_sequence > highest_sequence:
            highest_sequence = parsed_sequence
    return highest_sequence + 1


def _normalize_site_number(site_number: str | None) -> str:
    return (site_number or "").strip()
