from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from io import BytesIO
import re

import pdfplumber


class MeasurementTimesheetParseError(ValueError):
    pass


@dataclass(frozen=True)
class ParsedMeasurementItem:
    position: str
    description: str
    list_quantity: Decimal | None
    unit: str | None
    minutes_per_unit: Decimal | None
    list_minutes_total: Decimal | None
    is_nep: bool
    sort_order: int


@dataclass(frozen=True)
class MeasurementTimesheetParseResult:
    source_project_number: str | None
    source_invoice_number: str | None
    source_customer_name: str | None
    items: list[ParsedMeasurementItem]


_NUMBER_RE = r"\d+(?:\.\d{3})*,\d{2}"
_ROW_RE = re.compile(
    rf"^(?P<left>.+?)\s+(?P<quantity>{_NUMBER_RE})\s*(?P<unit>[A-Za-zÄÖÜäöüß/]+)\s+"
    rf"(?P<minutes_per_unit>{_NUMBER_RE})\s+(?P<minutes_total>NEP|{_NUMBER_RE})$"
)
_BASE_WITH_ITEM_RE = re.compile(
    r"^(?P<base>N?\d+(?:\.\d+)*\.)\s+(?P<item>\d+[a-z]?)\s+(?P<description>.+)$"
)
_FULL_POSITION_RE = re.compile(
    r"^(?P<position>N?\d+(?:\.\d+)+(?:[a-z])?)\s+(?P<description>.+)$"
)
_PENDING_BASE_RE = re.compile(r"^(?P<base>N?\d+(?:\.\d+)*\.)\s+(?P<description>.+)$")
_SUFFIX_LINE_RE = re.compile(r"^(?P<item>\d+[a-z]?)\b\s*(?P<description>.*)$")
_GROUP_HEADING_RE = re.compile(rf"^N?\d+(?:\.\d+)*\s+.+\s+{_NUMBER_RE}$")
_SKIP_LINE_PREFIXES = (
    "Zeit-Vorgabeliste",
    "Position Bezeichnung",
)


def parse_measurement_timesheet_pdf(pdf_bytes: bytes) -> MeasurementTimesheetParseResult:
    if not pdf_bytes:
        raise MeasurementTimesheetParseError("Leere PDF-Datei.")

    lines: list[str] = []
    try:
        with pdfplumber.open(BytesIO(pdf_bytes)) as pdf:
            for page in pdf.pages:
                text = page.extract_text() or ""
                lines.extend(text.splitlines())
    except Exception as exc:  # pragma: no cover - pdfplumber error type differs by input
        raise MeasurementTimesheetParseError("PDF konnte nicht gelesen werden.") from exc

    return parse_measurement_timesheet_lines(lines)


def parse_measurement_timesheet_lines(lines: list[str]) -> MeasurementTimesheetParseResult:
    source_project_number: str | None = None
    source_invoice_number: str | None = None
    source_customer_name = _extract_source_customer_name(lines)
    items: list[ParsedMeasurementItem] = []
    current: dict | None = None

    for raw_line in lines:
        line = _normalize_whitespace(raw_line)
        if not line or line.startswith(_SKIP_LINE_PREFIXES):
            continue
        if line.startswith("Projekt ="):
            source_project_number = _value_after_equals(line)
            continue
        if line.startswith("Rechnung ="):
            source_invoice_number = _value_after_equals(line)
            continue
        if line.startswith("Name1 ="):
            continue

        row_match = _ROW_RE.match(line)
        if row_match:
            finalized = _finalize_current_item(current, len(items) + 1)
            if finalized is not None:
                items.append(finalized)
            current = _start_item(row_match)
            continue

        if current is not None and not _is_non_position_table_line(line):
            _append_description_line(current, line)

    finalized = _finalize_current_item(current, len(items) + 1)
    if finalized is not None:
        items.append(finalized)

    if not items:
        raise MeasurementTimesheetParseError("Keine Positionszeilen in der Zeitenliste erkannt.")

    return MeasurementTimesheetParseResult(
        source_project_number=source_project_number,
        source_invoice_number=source_invoice_number,
        source_customer_name=source_customer_name,
        items=items,
    )


def _start_item(row_match: re.Match[str]) -> dict:
    left = row_match.group("left")
    position, description, pending_base = _split_position_and_description(left)
    minutes_total = row_match.group("minutes_total")
    is_nep = minutes_total == "NEP"
    return {
        "position": position,
        "pending_base": pending_base,
        "description_parts": [description] if description else [],
        "list_quantity": _parse_decimal(row_match.group("quantity")),
        "unit": row_match.group("unit"),
        "minutes_per_unit": _parse_decimal(row_match.group("minutes_per_unit")),
        "list_minutes_total": None if is_nep else _parse_decimal(minutes_total),
        "is_nep": is_nep,
    }


def _split_position_and_description(left: str) -> tuple[str | None, str, str | None]:
    match = _BASE_WITH_ITEM_RE.match(left)
    if match:
        return (
            _join_position(match.group("base"), match.group("item")),
            match.group("description"),
            None,
        )

    match = _FULL_POSITION_RE.match(left)
    if match:
        return match.group("position"), match.group("description"), None

    match = _PENDING_BASE_RE.match(left)
    if match:
        return None, match.group("description"), match.group("base")

    return None, left, None


def _is_non_position_table_line(line: str) -> bool:
    return line.lower().startswith("gesamt:") or bool(_GROUP_HEADING_RE.match(line))


def _append_description_line(current: dict, line: str) -> None:
    if current.get("pending_base") and not current.get("position"):
        suffix_match = _SUFFIX_LINE_RE.match(line)
        if suffix_match:
            current["position"] = _join_position(current["pending_base"], suffix_match.group("item"))
            suffix_description = suffix_match.group("description")
            if suffix_description:
                current["description_parts"].append(suffix_description)
            return
    current["description_parts"].append(line)


def _finalize_current_item(current: dict | None, sort_order: int) -> ParsedMeasurementItem | None:
    if current is None or not current.get("position"):
        return None

    description = _normalize_description(" ".join(current["description_parts"]))
    if not description:
        return None

    return ParsedMeasurementItem(
        position=current["position"],
        description=description,
        list_quantity=current["list_quantity"],
        unit=current["unit"],
        minutes_per_unit=current["minutes_per_unit"],
        list_minutes_total=current["list_minutes_total"],
        is_nep=current["is_nep"],
        sort_order=sort_order,
    )


def _extract_source_customer_name(lines: list[str]) -> str | None:
    parts: list[str] = []
    collecting = False
    for raw_line in lines:
        line = _normalize_whitespace(raw_line)
        if not line:
            continue
        if line.startswith("Name1 ="):
            parts.append(_value_after_equals(line) or "")
            collecting = True
            continue
        if collecting:
            if line.startswith("Position Bezeichnung"):
                break
            parts.append(line)

    result = ""
    for part in parts:
        if not part:
            continue
        if result.endswith("-"):
            result += part
        elif result:
            result += f" {part}"
        else:
            result = part
    return _normalize_whitespace(result) or None


def _normalize_whitespace(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def _normalize_description(value: str) -> str:
    return _normalize_whitespace(value)


def _value_after_equals(line: str) -> str | None:
    _, _, value = line.partition("=")
    value = _normalize_whitespace(value)
    return value or None


def _join_position(base: str, item: str) -> str:
    return f"{base.rstrip('.')}.{item}"


def _parse_decimal(value: str) -> Decimal:
    normalized = value.replace(".", "").replace(",", ".")
    try:
        return Decimal(normalized)
    except InvalidOperation as exc:
        raise MeasurementTimesheetParseError(f"Zahl konnte nicht gelesen werden: {value}") from exc
