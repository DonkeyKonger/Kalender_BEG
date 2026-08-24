from __future__ import annotations

from reportlab.pdfbase.pdfmetrics import stringWidth


EXTRA_WORK_REMARKS_FIELD_WIDTH = 136.08
EXTRA_WORK_REMARKS_FIELD_HEIGHT = 176.76
EXTRA_WORK_REMARKS_FONT_SIZE = 7.5
EXTRA_WORK_REMARKS_LINE_HEIGHT = 9.5
EXTRA_WORK_REMARKS_PADDING_INLINE = 2.0
EXTRA_WORK_REMARKS_PADDING_TOP = 2.0
EXTRA_WORK_REMARKS_PADDING_BOTTOM = 2.0
EXTRA_WORK_REMARKS_INNER_WIDTH = (
    EXTRA_WORK_REMARKS_FIELD_WIDTH - 2 * EXTRA_WORK_REMARKS_PADDING_INLINE
)
EXTRA_WORK_REMARKS_MAX_LINES = int(
    (
        EXTRA_WORK_REMARKS_FIELD_HEIGHT
        - EXTRA_WORK_REMARKS_FONT_SIZE
        - EXTRA_WORK_REMARKS_PADDING_TOP
        - EXTRA_WORK_REMARKS_PADDING_BOTTOM
    )
    // EXTRA_WORK_REMARKS_LINE_HEIGHT
) + 1


def wrap_extra_work_remarks(value: str | None) -> list[str]:
    text = _normalize_multiline(value)
    if not text:
        return []

    lines: list[str] = []
    for paragraph in text.split("\n"):
        words = paragraph.split()
        if not words:
            lines.append("")
            continue
        lines.extend(_wrap_words(words))
    return lines


def extra_work_remarks_fit(value: str | None) -> bool:
    return len(wrap_extra_work_remarks(value)) <= EXTRA_WORK_REMARKS_MAX_LINES


def extra_work_remarks_width(value: str) -> float:
    printable_value = value.encode("cp1252", errors="replace").decode("cp1252")
    return stringWidth(printable_value, "Helvetica", EXTRA_WORK_REMARKS_FONT_SIZE)


def _wrap_words(words: list[str]) -> list[str]:
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if extra_work_remarks_width(candidate) <= EXTRA_WORK_REMARKS_INNER_WIDTH:
            current = candidate
            continue
        if current:
            lines.append(current)
            current = ""
        if extra_work_remarks_width(word) <= EXTRA_WORK_REMARKS_INNER_WIDTH:
            current = word
            continue
        fragments = _split_token_to_width(word)
        lines.extend(fragments[:-1])
        current = fragments[-1] if fragments else ""
    if current:
        lines.append(current)
    return lines


def _split_token_to_width(token: str) -> list[str]:
    fragments: list[str] = []
    current = ""
    for character in token:
        candidate = current + character
        if current and extra_work_remarks_width(candidate) > EXTRA_WORK_REMARKS_INNER_WIDTH:
            fragments.append(current)
            current = character
        else:
            current = candidate
    if current:
        fragments.append(current)
    return fragments


def _normalize_multiline(value: str | None) -> str:
    if value is None:
        return ""
    return str(value).replace("\r\n", "\n").replace("\r", "\n")
