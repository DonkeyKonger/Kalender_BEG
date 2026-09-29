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
