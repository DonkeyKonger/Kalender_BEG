"""Render one continuous matrix from the immutable aggregate, not source PDFs."""
from datetime import datetime
from decimal import Decimal
from textwrap import wrap

from app.services.measurement_pdf_service import (
    LOGO_PATH, LOGO_RESOURCE_NAME, MatrixArea, MatrixCellValue, MatrixPosition, SimplePdf,
    _build_logical_measurement_blocks, _build_measurement_pdf_pages, _draw_grand_total,
    _draw_measurement_matrix, _draw_signature, _format_sheet_label, _line, _load_png_rgb,
    _signature_block, _template_header, _text, _text_fitted,
)


def render_group_pdf(group):
    snapshot = group.snapshot
    positions = [MatrixPosition(**item) for item in snapshot["positions"]]
    areas = [MatrixArea(**area) for area in snapshot["areas"]]
    cells = {(cell["area"], cell["item_id"]): MatrixCellValue(quantity=Decimal(cell["quantity"]))
             for cell in snapshot["cells"]}
    pages = _build_measurement_pdf_pages(_build_logical_measurement_blocks(
        positions=positions, areas=areas, cells=cells, include_zero_positions=True))
    workers = snapshot["workers"]
    # Never overlay multiple original signatures in a single signature box.
    signature_pages = [workers[index:index + 6] for index in range(0, len(workers), 6)] if len(workers) > 1 else []
    count = len(pages) + len(signature_pages)
    pdf = SimplePdf()
    logo = _load_png_rgb(LOGO_PATH)
    if logo:
        pdf.add_image(LOGO_RESOURCE_NAME, logo)

    def header(commands, page_number):
        # A source reference on EVERY page, including signature continuation pages.
        sources = "Zusammengesetzt aus Aufmaßen: " + ", ".join(source["number_label"] for source in group.sources)
        lines = wrap(sources, width=175, break_long_words=True, break_on_hyphens=False)
        line_height = min(8, 52 / max(1, len(lines)))
        for index, line in enumerate(lines):
            _text_fitted(commands, 51, 577 - index * line_height, line, min(7, line_height), max_width=714)
        _template_header(commands=commands, title=group.number_label,
            customer=snapshot["site"]["customer"], project=snapshot["site"]["name"],
            commission=snapshot["site"]["number"], date_label=datetime.fromisoformat(snapshot["date"]).strftime("%d.%m.%Y"),
            sheet_label=_format_sheet_label(group.number_label, page_number, count), logo=logo)
        _text(commands, 160, 513, f"Gesamtaufmaß {group.number_label}", 11, "F2")
        _text(commands, 764, 8, f"Seite {page_number} von {count}", 6, align_right=True)

    for number, page in enumerate(pages, 1):
        commands = [b"0.75 w"]
        header(commands, number)
        _draw_measurement_matrix(commands=commands, positions=page.positions, areas=page.areas,
                                 cells=page.cells, totals_by_position=page.totals_by_position)
        if number == len(pages):
            _draw_grand_total(commands)
            customer = snapshot["customer"] or {}
            worker = workers[0] if len(workers) == 1 else {}
            notes = []
            if customer:
                notes.append(f"Kundenunterschriften in allen Einzelaufmaßen vorhanden; übernommen aus {customer['source']}.")
            else:
                notes.append("Keine Kundenunterschrift übernommen: nicht in allen Einzelaufmaßen vorhanden.")
            if signature_pages:
                notes.append("Monteursunterschriften siehe Folgeblatt.")
            elif worker:
                notes.append(f"Monteursunterschrift aus {worker['source']}.")
            _text_fitted(commands, 51, 68, " ".join(notes), 6, max_width=713)
            _signature_block(commands, contractor_name="Siehe Unterschriften" if signature_pages else "-",
                worker_name=worker.get("name"), worker_signature_strokes=worker.get("strokes"),
                customer_name=customer.get("name"), customer_signature_place=customer.get("place"),
                customer_signed_at=datetime.fromisoformat(customer["signed_at"]) if customer else None,
                customer_signature_strokes=customer.get("strokes"))
        else:
            _text(commands, 764, 68, "Fortsetzung auf folgendem Blatt", 8, align_right=True)
        pdf.add_page(commands)
    for page_offset, signatures in enumerate(signature_pages, len(pages) + 1):
        commands = [b"0.75 w"]
        header(commands, page_offset)
        _text(commands, 51, 414, "Übernommene Monteursunterschriften", 12, "F2")
        for index, signature in enumerate(signatures):
            x, y = 51 + (index % 2) * 370, 380 - (index // 2) * 120
            _text_fitted(commands, x, y, signature["name"] or "Monteur", 10, font="F2", max_width=330)
            signed = datetime.fromisoformat(signature["signed_at"]).strftime("%d.%m.%Y")
            _text_fitted(commands, x, y - 15, f"Aufmaß {signature['source']} · {signed}", 8, max_width=330)
            _draw_signature(commands, signature["strokes"], x=x, y=y - 65, width=200, height=40)
            _line(commands, x, y - 70, x + 320, y - 70)
        pdf.add_page(commands)
    return pdf.build()
