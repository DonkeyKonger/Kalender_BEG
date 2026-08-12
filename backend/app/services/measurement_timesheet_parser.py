from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from io import BytesIO
import logging
import re

import pdfplumber
from pdfplumber.page import Page


LOGGER = logging.getLogger(__name__)


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
    source_section_key: str | None = None
    source_section_title: str | None = None


@dataclass(frozen=True)
class MeasurementTimesheetParseResult:
    source_project_number: str | None
    source_invoice_number: str | None
    source_customer_name: str | None
    items: list[ParsedMeasurementItem]


_NUMBER_RE = r"-?\d+(?:\.\d{3})*,\d{2}"
_SECTION_KEY_RE = r"(?:N(?:\.?\d+)(?:/N?\d+)*(?:\.\d+)*|\d+(?:\.\d+)*)"
_ROW_RE = re.compile(
    rf"^(?P<left>.+?)\s+(?P<quantity>{_NUMBER_RE})\s*(?P<unit>[A-Za-zÄÖÜäöüß/]+)\s+"
    rf"(?P<minutes_per_unit>{_NUMBER_RE})\s+(?P<minutes_total>NEP|{_NUMBER_RE})$"
)
_BASE_WITH_ITEM_RE = re.compile(
    rf"^(?P<base>{_SECTION_KEY_RE}\.+)\s+(?P<item>\d+[a-z]?)\s+(?P<description>.+)$"
)
_FULL_POSITION_RE = re.compile(
    r"^(?P<position>(?=[A-Za-z0-9./-]*\d)[A-Za-z0-9]+"
    r"(?:[./-]+[A-Za-z0-9]+)+(?:-)?)\s+(?P<description>.+)$"
)
_PENDING_BASE_RE = re.compile(rf"^(?P<base>{_SECTION_KEY_RE}\.+)\s+(?P<description>.+)$")
_SUFFIX_LINE_RE = re.compile(r"^(?P<item>\d+[a-z]?)\b\s*(?P<description>.*)$")
_RANGE_SUFFIX_LINE_RE = re.compile(r"^-(?P<item>\d+[A-Za-z]?)\b\s*(?P<description>.*)$")
_TRAILING_HYPHEN_SUFFIX_LINE_RE = re.compile(r"^(?P<item>\d+[A-Za-z]?)\b\s*(?P<description>.*)$")
_GROUP_HEADING_RE = re.compile(
    rf"^(?P<section>{_SECTION_KEY_RE}\.?)\s+(?P<title>.+?)(?:\s+{_NUMBER_RE})?$"
)
_POSITION_LAYOUT_RE = re.compile(r"^(?=.*\d)[A-Za-z0-9]+(?:[./-]+[A-Za-z0-9]+)*\.?$")
_QUANTITY_AND_UNIT_RE = re.compile(rf"^(?P<quantity>{_NUMBER_RE})\s*(?P<unit>[A-Za-zÄÖÜäöüß/]+)$")
_NUMBER_TOKEN_RE = re.compile(rf"^{_NUMBER_RE}$")
_TOTAL_TOKEN_RE = re.compile(rf"^(?:NEP|{_NUMBER_RE})$", re.IGNORECASE)
_TABLE_HEADER_TOKENS = {"Position", "Bezeichnung", "Menge"}
_WORD_LINE_TOLERANCE = 1.25
_SKIP_LINE_PREFIXES = (
    "Zeit-Vorgabeliste",
    "Position Bezeichnung",
)


def parse_measurement_timesheet_pdf(pdf_bytes: bytes) -> MeasurementTimesheetParseResult:
    if not pdf_bytes:
        raise MeasurementTimesheetParseError("Leere PDF-Datei.")

    try:
        with pdfplumber.open(BytesIO(pdf_bytes)) as pdf:
            fallback_lines = [
                line for page in pdf.pages for line in (page.extract_text() or "").splitlines()
            ]
            geometry_lines, skipped_candidates = _extract_geometry_table_lines(pdf.pages)
    except Exception as exc:  # pragma: no cover - pdfplumber error type differs by input
        raise MeasurementTimesheetParseError("PDF konnte nicht gelesen werden.") from exc

    if geometry_lines:
        metadata_lines = _extract_metadata_lines(fallback_lines)
        try:
            result = parse_measurement_timesheet_lines([*metadata_lines, *geometry_lines])
        except MeasurementTimesheetParseError:
            LOGGER.warning(
                "Positionsbasierte Zeitenlisten-Erkennung lieferte keine Position; "
                "Text-Fallback wird verwendet."
            )
        else:
            LOGGER.info(
                "Zeitenliste positionsbasiert gelesen: parsed_positions=%d skipped_candidates=%d",
                len(result.items),
                skipped_candidates,
            )
            return result

    result = parse_measurement_timesheet_lines(fallback_lines)
    LOGGER.info(
        "Zeitenliste mit Text-Fallback gelesen: parsed_positions=%d skipped_candidates=0",
        len(result.items),
    )
    return result


def _extract_metadata_lines(lines: list[str]) -> list[str]:
    metadata_lines: list[str] = []
    for raw_line in lines:
        metadata_lines.append(raw_line)
        if _normalize_whitespace(raw_line).startswith("Position Bezeichnung"):
            break
    return metadata_lines


def _extract_geometry_table_lines(pages: list[Page]) -> tuple[list[str], int]:
    column_bounds: tuple[float, ...] | None = None
    reference_width: float | None = None
    for page in pages:
        column_bounds = _find_table_column_bounds(page)
        if column_bounds is not None:
            reference_width = float(page.width)
            break

    if column_bounds is None or reference_width is None:
        return [], 0

    extracted_lines: list[str] = []
    skipped_candidates = 0
    for page_number, page in enumerate(pages, start=1):
        width_factor = float(page.width) / reference_width
        page_bounds = tuple(bound * width_factor for bound in column_bounds)
        page_lines, page_skipped = _extract_page_table_lines(
            page,
            page_bounds,
            page_number=page_number,
        )
        extracted_lines.extend(page_lines)
        skipped_candidates += page_skipped

    return extracted_lines, skipped_candidates


def _find_table_column_bounds(page: Page) -> tuple[float, ...] | None:
    physical_lines = _group_words_by_line(page)
    header_top: float | None = None
    for top, words in physical_lines:
        texts = {str(word["text"]) for word in words}
        if _TABLE_HEADER_TOKENS.issubset(texts) and sum(text == "Minuten" for text in texts) >= 1:
            header_top = top
            break

    if header_top is None:
        return None

    header_intervals: list[tuple[float, float]] = []
    for rect in page.rects:
        width = float(rect.get("width", 0))
        height = float(rect.get("height", 0))
        top = float(rect.get("top", 0))
        if width < float(page.width) * 0.04 or height > 0.5 or not (0 < header_top - top < 5):
            continue
        interval = (float(rect["x0"]), float(rect["x1"]))
        if not any(
            abs(interval[0] - existing[0]) < 0.5 and abs(interval[1] - existing[1]) < 0.5
            for existing in header_intervals
        ):
            header_intervals.append(interval)

    header_intervals.sort()
    if len(header_intervals) == 5:
        return (
            header_intervals[0][0],
            *(
                (header_intervals[index][1] + header_intervals[index + 1][0]) / 2
                for index in range(4)
            ),
            header_intervals[-1][1],
        )

    # Access-generated timesheets use the same five-column report template even if
    # the PDF producer omits the thin header rectangles from its text layer.
    return tuple(
        float(page.width) * ratio for ratio in (0.0954, 0.1912, 0.5790, 0.7178, 0.8370, 0.9568)
    )


def _group_words_by_line(page: Page) -> list[tuple[float, list[dict]]]:
    words = page.extract_words(x_tolerance=1, y_tolerance=2, keep_blank_chars=False)
    grouped: list[tuple[float, list[dict]]] = []
    for word in sorted(words, key=lambda value: (float(value["top"]), float(value["x0"]))):
        top = float(word["top"])
        if grouped and abs(grouped[-1][0] - top) <= _WORD_LINE_TOLERANCE:
            grouped[-1][1].append(word)
        else:
            grouped.append((top, [word]))
    return grouped


def _extract_page_table_lines(
    page: Page,
    column_bounds: tuple[float, ...],
    *,
    page_number: int,
) -> tuple[list[str], int]:
    physical_lines = _group_words_by_line(page)
    classified: list[tuple[int, str, dict[str, str]]] = []

    for index, (_, words) in enumerate(physical_lines):
        columns = [
            _words_in_column(words, column_bounds[column], column_bounds[column + 1])
            for column in range(5)
        ]
        texts = [_words_text(column_words) for column_words in columns]
        row_values = _parse_geometry_row_values(texts)
        if row_values is not None:
            classified.append((index, "item", row_values))
            continue
        if _is_geometry_group_heading(texts):
            classified.append(
                (
                    index,
                    "heading",
                    {"position": _compact_position(texts[0]), "description": texts[1]},
                )
            )

    if not classified:
        return [], 0

    extracted_lines: list[str] = []
    skipped_candidates = 0
    for classified_index, (line_index, line_type, values) in enumerate(classified):
        if line_type == "heading":
            extracted_lines.append(f"{values['position']} {values['description']}")
            continue

        next_line_index = (
            classified[classified_index + 1][0]
            if classified_index + 1 < len(classified)
            else len(physical_lines)
        )
        block = physical_lines[line_index:next_line_index]
        position = _compact_position(
            "".join(
                _words_text(_words_in_column(words, column_bounds[0], column_bounds[1]))
                for _, words in block
            )
        )
        description = _normalize_description(
            " ".join(
                _words_text(_words_in_column(words, column_bounds[1], column_bounds[2]))
                for _, words in block
            )
        )

        if not position or not description or not _POSITION_LAYOUT_RE.fullmatch(position):
            skipped_candidates += 1
            LOGGER.debug(
                "Zeitenlisten-Kandidat verworfen: page=%d top=%.2f position=%r description=%r",
                page_number,
                physical_lines[line_index][0],
                position,
                description,
            )
            continue

        extracted_lines.append(
            " ".join(
                (
                    position,
                    description,
                    values["quantity"],
                    values["unit"],
                    values["minutes_per_unit"],
                    values["minutes_total"],
                )
            )
        )

    return extracted_lines, skipped_candidates


def _words_in_column(words: list[dict], left: float, right: float) -> list[dict]:
    return [
        word
        for word in words
        if left - 0.75 <= (float(word["x0"]) + float(word["x1"])) / 2 < right + 0.75
    ]


def _words_text(words: list[dict]) -> str:
    return " ".join(
        str(word["text"]) for word in sorted(words, key=lambda value: float(value["x0"]))
    )


def _parse_geometry_row_values(texts: list[str]) -> dict[str, str] | None:
    position, description, quantity_and_unit, minutes_per_unit, minutes_total = texts
    quantity_match = _QUANTITY_AND_UNIT_RE.fullmatch(quantity_and_unit)
    if (
        not position
        or not description
        or quantity_match is None
        or _NUMBER_TOKEN_RE.fullmatch(minutes_per_unit) is None
        or _TOTAL_TOKEN_RE.fullmatch(minutes_total) is None
    ):
        return None
    return {
        "quantity": quantity_match.group("quantity"),
        "unit": quantity_match.group("unit"),
        "minutes_per_unit": minutes_per_unit,
        "minutes_total": minutes_total.upper(),
    }


def _is_geometry_group_heading(texts: list[str]) -> bool:
    position, description, quantity_and_unit, minutes_per_unit, minutes_total = texts
    compact_position = _compact_position(position)
    has_explicit_section_shape = (
        "." in compact_position
        or "/" in compact_position
        or compact_position.upper().startswith("N")
    )
    return bool(
        position
        and description
        and not quantity_and_unit
        and not minutes_per_unit
        and (not minutes_total or _NUMBER_TOKEN_RE.fullmatch(minutes_total))
        and (bool(minutes_total) or has_explicit_section_shape)
    )


def _compact_position(value: str) -> str:
    return re.sub(r"\s+", "", value)


def parse_measurement_timesheet_lines(lines: list[str]) -> MeasurementTimesheetParseResult:
    source_project_number: str | None = None
    source_invoice_number: str | None = None
    source_customer_name = _extract_source_customer_name(lines)
    items: list[ParsedMeasurementItem] = []
    current: dict | None = None
    synthetic_position_counters: dict[str, int] = {}
    section_headings: dict[str, str] = {}

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
            finalized = _finalize_current_item(current, len(items) + 1, section_headings)
            if finalized is not None:
                items.append(finalized)
            current = _start_item(row_match, synthetic_position_counters)
            continue

        if current is not None and _append_position_continuation(current, line):
            continue

        group_heading = _parse_group_heading(line)
        if group_heading is not None:
            finalized = _finalize_current_item(current, len(items) + 1, section_headings)
            if finalized is not None:
                items.append(finalized)
            current = None
            section_key, section_title = group_heading
            section_headings[section_key] = section_title
            continue

        if current is not None and not _is_non_position_table_line(line):
            _append_description_line(current, line)

    finalized = _finalize_current_item(current, len(items) + 1, section_headings)
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


def _start_item(row_match: re.Match[str], synthetic_position_counters: dict[str, int]) -> dict:
    left = row_match.group("left")
    position, description, pending_base = _split_position_and_description(left)
    if position is None and pending_base and _can_synthesize_position(pending_base):
        synthetic_position_counters[pending_base] = (
            synthetic_position_counters.get(pending_base, 0) + 1
        )
        position = _join_position(pending_base, str(synthetic_position_counters[pending_base]))
        pending_base = None
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


def _parse_group_heading(line: str) -> tuple[str, str] | None:
    if _ROW_RE.match(line):
        return None
    match = _GROUP_HEADING_RE.match(line)
    if not match:
        return None
    section_key = _normalize_section_key(match.group("section"))
    section_title = _normalize_description(match.group("title"))
    if not section_key or not section_title:
        return None
    return section_key, section_title


def _is_non_position_table_line(line: str) -> bool:
    return line.lower().startswith("gesamt:") or _parse_group_heading(line) is not None


def _can_synthesize_position(base: str) -> bool:
    return bool(re.fullmatch(r"N?\d+\.", base))


def _append_description_line(current: dict, line: str) -> None:
    current["description_parts"].append(line)


def _append_position_continuation(current: dict, line: str) -> bool:
    if current.get("pending_base") and not current.get("position"):
        suffix_match = _SUFFIX_LINE_RE.match(line)
        if suffix_match:
            current["position"] = _join_position(
                current["pending_base"], suffix_match.group("item")
            )
            suffix_description = suffix_match.group("description")
            if suffix_description:
                current["description_parts"].append(suffix_description)
            return True

    position = current.get("position")
    if not position:
        return False

    range_match = _RANGE_SUFFIX_LINE_RE.match(line)
    if range_match and "-" not in position:
        current["position"] = f"{position}-{range_match.group('item')}"
        range_description = range_match.group("description")
        if range_description:
            current["description_parts"].append(range_description)
        return True

    if position.endswith("-"):
        trailing_match = _TRAILING_HYPHEN_SUFFIX_LINE_RE.match(line)
        if trailing_match:
            current["position"] = f"{position}{trailing_match.group('item')}"
            trailing_description = trailing_match.group("description")
            if trailing_description:
                current["description_parts"].append(trailing_description)
            return True

    return False


def _finalize_current_item(
    current: dict | None, sort_order: int, section_headings: dict[str, str]
) -> ParsedMeasurementItem | None:
    if current is None or not current.get("position"):
        return None

    description = _normalize_description(" ".join(current["description_parts"]))
    if not description:
        return None

    source_section_key, source_section_title = _find_section_heading_for_position(
        current["position"], section_headings
    )

    return ParsedMeasurementItem(
        position=current["position"],
        description=description,
        list_quantity=current["list_quantity"],
        unit=current["unit"],
        minutes_per_unit=current["minutes_per_unit"],
        list_minutes_total=current["list_minutes_total"],
        is_nep=current["is_nep"],
        sort_order=sort_order,
        source_section_key=source_section_key,
        source_section_title=source_section_title,
    )


def _find_section_heading_for_position(
    position: str, section_headings: dict[str, str]
) -> tuple[str | None, str | None]:
    position_key = _normalize_section_key(position)
    matching_keys = [
        key for key in section_headings if position_key == key or position_key.startswith(f"{key}.")
    ]
    if not matching_keys:
        return None, None
    best_key = max(matching_keys, key=lambda key: (key.count("."), len(key)))
    return best_key, section_headings[best_key]


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


def _normalize_section_key(value: str) -> str:
    normalized = _normalize_whitespace(value)
    normalized = re.sub(r"\s*\.\s*", ".", normalized)
    normalized = re.sub(r"\s*/\s*", "/", normalized)
    normalized = re.sub(r"\.{2,}", ".", normalized)
    return normalized.rstrip(".").upper()


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
