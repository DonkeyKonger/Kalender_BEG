"""Four printed lines in I46:L49, measured for Arial 10 with a safety margin."""
from reportlab.pdfbase.pdfmetrics import stringWidth

MAX_LINES = 4
MAX_WIDTH = 14400  # 144 pt at 10 pt; merged template cells are about 162 pt wide.
MAX_LENGTH = 512
CHARACTER_WIDTHS = {
    char: round(stringWidth(char, "Helvetica", 1000))
    for char in dict.fromkeys("".join(chr(n) for n in range(32, 256)) + "€„“‚‘’–—…")
}
UNKNOWN_WIDTH = 2000  # Conservative allowance for fallback fonts / Unicode symbols.


def remarks_layout() -> dict:
    return {"max_lines": MAX_LINES, "max_width": MAX_WIDTH,
            "max_length": MAX_LENGTH, "character_widths": CHARACTER_WIDTHS,
            "unknown_width": UNKNOWN_WIDTH}


def normalize_remarks(value: str) -> str:
    return value.replace("\r\n", "\n").replace("\r", "\n").replace("\t", "    ")


def wrap_remarks(value: str) -> list[str]:
    """Keep explicit breaks; word-wrap and split long words without losing text."""
    value = normalize_remarks(value)
    if any(ord(c) < 32 and c != "\n" or 0xD800 <= ord(c) <= 0xDFFF
           or ord(c) in (0xFFFE, 0xFFFF) for c in value):
        raise ValueError("Die Bemerkung enthält ein nicht unterstütztes Steuerzeichen.")
    if not value:
        return []
    lines = []
    for paragraph in value.split("\n"):
        while paragraph:
            width, end = 0, 0
            for char in paragraph:
                next_width = width + CHARACTER_WIDTHS.get(char, UNKNOWN_WIDTH)
                if next_width > MAX_WIDTH:
                    break
                width, end = next_width, end + 1
            if end == len(paragraph):
                break
            space = paragraph.rfind(" ", 0, end)
            cut = space + 1 if space > 0 else end
            lines.append(paragraph[:cut])
            paragraph = paragraph[cut:]
        lines.append(paragraph)
    return lines


def validate_remarks(value: str) -> str:
    value = normalize_remarks(value)
    if len(value) > MAX_LENGTH or len(wrap_remarks(value)) > MAX_LINES:
        raise ValueError("Das Excel-Feld hat nur 4 Zeilen. Bitte die Bemerkung kürzen.")
    return value
