from datetime import date, datetime, timedelta

from sqlalchemy.orm import Session

from app.schemas.matrix import MatrixRow
from app.services.matrix_service import MatrixService
from app.services.person_display import calendar_short_code_from_values

PAGE_WIDTH = 595
PAGE_HEIGHT = 842
MARGIN = 42
LINE_HEIGHT = 14


class SimplePdf:
    def __init__(self) -> None:
        self.pages: list[list[str]] = []
        self._current: list[str] = []
        self._y = PAGE_HEIGHT - MARGIN

    def add_page(self) -> None:
        if self._current:
            self.pages.append(self._current)
        self._current = []
        self._y = PAGE_HEIGHT - MARGIN

    def add_heading(self, title: str, subtitle: str | None = None) -> None:
        if not self._current:
            self.add_page()
        self.text(title, size=18, bold=True)
        if subtitle:
            self.text(subtitle, size=9)
        self.space(8)

    def text(self, value: str, *, size: int = 10, bold: bool = False, indent: int = 0) -> None:
        max_chars = max(34, int((PAGE_WIDTH - (2 * MARGIN) - indent) / (size * 0.52)))
        font = "F2" if bold else "F1"
        x = MARGIN + indent
        for line in wrap_text(value, max_chars):
            if self._y < MARGIN + 28:
                self.add_page()
            self._current.append(
                f"BT /{font} {size} Tf 1 0 0 1 {x} {self._y} Tm ({escape_pdf(line)}) Tj ET"
            )
            self._y -= LINE_HEIGHT

    def space(self, amount: int = 6) -> None:
        self._y -= amount

    def render(self) -> bytes:
        if self._current:
            self.pages.append(self._current)
            self._current = []
        if not self.pages:
            self.add_page()
            self.pages.append(self._current)

        objects: list[bytes] = []
        objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
        page_object_ids: list[int] = []
        content_object_ids: list[int] = []

        object_id = 5
        for _page in self.pages:
            page_object_ids.append(object_id)
            content_object_ids.append(object_id + 1)
            object_id += 2

        kids = " ".join(f"{page_id} 0 R" for page_id in page_object_ids)
        objects.append(f"<< /Type /Pages /Kids [{kids}] /Count {len(page_object_ids)} >>".encode("latin-1"))
        objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
        objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>")

        for page_id, content_id, lines in zip(page_object_ids, content_object_ids, self.pages, strict=True):
            objects.append(
                (
                    f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE_WIDTH} {PAGE_HEIGHT}] "
                    f"/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> "
                    f"/Contents {content_id} 0 R >>"
                ).encode("latin-1")
            )
            stream = "\n".join(lines).encode("latin-1", errors="replace")
            objects.append(b"<< /Length " + str(len(stream)).encode("ascii") + b" >>\nstream\n" + stream + b"\nendstream")

        return build_pdf(objects)


class PdfExportService:
    def __init__(self, db: Session) -> None:
        self.matrix = MatrixService(db)

    def daily_plan(self, plan_date: date) -> bytes:
        matrix = self.matrix.get_matrix(
            start=plan_date,
            end=plan_date,
            include_weekends=True,
            include_closed=False,
        )
        pdf = SimplePdf()
        pdf.add_heading(
            f"Tagesplan - {format_date(plan_date)}",
            f"Erstellt am {datetime.now().strftime('%d.%m.%Y %H:%M')}",
        )

        planned_rows = [row for row in matrix.rows if row.cells and row.cells[0].assignments]
        if not planned_rows:
            pdf.text("Keine Einsaetze fuer diesen Tag geplant.")
            return pdf.render()

        for row in planned_rows:
            cell = row.cells[0]
            pdf.text(site_title(row), bold=True)
            pdf.text(f"Ort: {row.site.location or '-'}", indent=12)
            pdf.text(f"PL: {project_manager_code(row)}", indent=12)
            pdf.text("Personen: " + ", ".join(item.person.display_name for item in cell.assignments), indent=12)
            notes = [item.note for item in cell.assignments if item.note]
            if row.site.info:
                pdf.text(f"Info: {row.site.info}", indent=12)
            if notes:
                pdf.text("Notizen: " + " | ".join(notes), indent=12)
            pdf.space(8)
        return pdf.render()

    def weekly_plan(self, week_start: date) -> bytes:
        start = week_start - timedelta(days=week_start.weekday())
        end = start + timedelta(days=6)
        matrix = self.matrix.get_matrix(
            start=start,
            end=end,
            include_weekends=True,
            include_closed=False,
        )
        pdf = SimplePdf()
        pdf.add_heading(
            f"Wochenplan - KW {start.isocalendar().week}",
            f"{format_date(start)} bis {format_date(end)} | Erstellt am {datetime.now().strftime('%d.%m.%Y %H:%M')}",
        )

        planned_rows = [row for row in matrix.rows if any(cell.assignments for cell in row.cells)]
        if not planned_rows:
            pdf.text("Keine Einsaetze fuer diese Woche geplant.")
            return pdf.render()

        for row in planned_rows:
            pdf.text(site_title(row), bold=True)
            pdf.text(f"Ort: {row.site.location or '-'} | PL: {project_manager_code(row)}", indent=12)
            for day, cell in zip(matrix.days, row.cells, strict=True):
                if not cell.assignments:
                    continue
                names = ", ".join(item.person.display_name for item in cell.assignments)
                pdf.text(f"{weekday_label(day.date)} {format_date(day.date)}: {names}", indent=12)
            if row.site.info:
                pdf.text(f"Info: {row.site.info}", indent=12)
            pdf.space(8)
        return pdf.render()


def site_title(row: MatrixRow) -> str:
    number = f"{row.site.site_number} - " if row.site.site_number else ""
    return f"{number}{row.site.name}"


def project_manager_code(row: MatrixRow) -> str:
    manager = row.site.project_manager
    if manager is None:
        return "-"
    return calendar_short_code_from_values(display_name=manager.display_name, short_code=manager.short_code)


def format_date(value: date) -> str:
    return value.strftime("%d.%m.%Y")


def weekday_label(value: date) -> str:
    return ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"][value.weekday()]


def wrap_text(value: str, max_chars: int) -> list[str]:
    words = value.split()
    if not words:
        return [""]

    lines: list[str] = []
    current = words[0]
    for word in words[1:]:
        if len(current) + len(word) + 1 <= max_chars:
            current = f"{current} {word}"
        else:
            lines.append(current)
            current = word
    lines.append(current)
    return lines


def escape_pdf(value: str) -> str:
    cleaned = value.replace("\n", " ").replace("\r", " ")
    cleaned = cleaned.encode("latin-1", errors="replace").decode("latin-1")
    return cleaned.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def build_pdf(objects: list[bytes]) -> bytes:
    output = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for index, body in enumerate(objects, start=1):
        offsets.append(len(output))
        output.extend(f"{index} 0 obj\n".encode("ascii"))
        output.extend(body)
        output.extend(b"\nendobj\n")

    xref_offset = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    output.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    output.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n".encode("ascii")
    )
    return bytes(output)
