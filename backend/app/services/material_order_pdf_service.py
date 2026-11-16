"""Normalize and fill the interactive material-order PDF.

The supplied master contains useful widget coordinates, but its 23 visible
``Gepackt`` checkboxes are all children of one checkbox field.  Reusing that
field would make the boxes change together.  This module therefore keeps the
master page as the visual background and recreates a small, passive AcroForm
with stable application field names and one independent field per checkbox.
"""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from functools import lru_cache
from importlib import resources
from io import BytesIO
from typing import Literal, Mapping

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (
    ArrayObject,
    BooleanObject,
    DecodedStreamObject,
    DictionaryObject,
    FloatObject,
    IndirectObject,
    NameObject,
    NumberObject,
    TextStringObject,
)
from reportlab.pdfbase.pdfmetrics import stringWidth

MATERIAL_ORDER_TEMPLATE_RESOURCE = (
    "templates/project_folders/Materialschein_Formular_Master.pdf"
)
MATERIAL_ORDER_ROW_COUNT = 23
CHECKBOX_ON_VALUE = "/Yes"
CHECKBOX_OFF_VALUE = "/Off"
DEFAULT_TEXT_FONT_SIZE = 8.0
MINIMUM_TEXT_FONT_SIZE = 3.0
TABLE_GRID_COLOR = 0.0
TABLE_PALE_BLUE = (0.753, 0.902, 0.961)
TABLE_LINE_WIDTH = 0.48
TABLE_COLUMN_BOUNDARIES = (55.926, 314.646, 371.286, 428.166, 484.806, 541.686)
TABLE_ROW_BOUNDARIES = (
    568.524,
    547.164,
    525.564,
    504.204,
    482.604,
    461.004,
    439.644,
    418.044,
    396.684,
    375.084,
    353.724,
    332.124,
    310.524,
    289.164,
    267.564,
    246.204,
    224.604,
    203.004,
    181.644,
    160.044,
    138.684,
    117.084,
    95.724,
    74.124,
)
TABLE_HEADER_TOP = 595.884


class MaterialOrderPdfValidationError(ValueError):
    """Raised when material-order values cannot be represented safely."""


@dataclass(frozen=True)
class _FieldDefinition:
    name: str
    label: str
    type: Literal["text", "checkbox"]
    rect: tuple[float, float, float, float]  # top-left x, y, width, height
    max_length: int | None = None
    font_size: float | None = None
    text_color: tuple[float, float, float] | None = None
    text_align: Literal["left", "center", "right"] | None = None


_HEADER_SOURCE_FIELDS = (
    ("customer", "Kunde", "Kunde", 120),
    ("project", "Projekt", "Projekt", 120),
    ("commission", "Kommission", "Kommission", 60),
    ("required_at", "Zum Termin", "zum Termin", 80),
    ("requested_by", "Angemeldet von", "angemeldet von", 80),
    ("pickup_by", "Mitnahme durch", "Mitnahme durch", 80),
)


def get_material_order_form() -> dict[str, object]:
    """Return the normalized React/PDF field descriptor.

    Rectangles use PDF points with a top-left origin so the frontend can place
    its React field layer directly over a PDF.js page of the reported size.
    """

    width, height, definitions = _material_order_schema()
    return {
        "width": width,
        "height": height,
        "fields": [
            {
                "name": field.name,
                "label": field.label,
                "type": field.type,
                "rect": list(field.rect),
                "max_length": field.max_length,
                "font_size": field.font_size,
                "text_color": list(field.text_color) if field.text_color else None,
                "text_align": field.text_align,
            }
            for field in definitions
        ],
    }


def get_material_order_template() -> bytes:
    """Return a clean interactive blank template with independent fields."""

    return _normalized_template_pdf()


def build_material_order_pdf(values: Mapping[str, str | bool]) -> bytes:
    """Fill allowed material-order values and return an interactive PDF.

    Omitted fields remain blank/off.  Unknown fields, mismatched value types,
    control characters, and text exceeding the field-specific limit are
    rejected instead of being silently truncated or written outside the form.
    """

    normalized_values = _validate_values(values)
    writer = PdfWriter(clone_from=PdfReader(BytesIO(_normalized_template_pdf())))
    writer.update_page_form_field_values(
        None,
        _pypdf_values(normalized_values, fit_text=True),
        auto_regenerate=False,
    )
    output = BytesIO()
    writer.write(output)
    content = output.getvalue()
    _verify_pdf(content, normalized_values)
    return content


def validate_material_order_values(values: Mapping[str, str | bool]) -> None:
    """Validate a partial draft without paying the cost of generating a PDF."""

    _validate_values(values)


@lru_cache(maxsize=1)
def _source_pdf_bytes() -> bytes:
    return resources.files("app").joinpath(MATERIAL_ORDER_TEMPLATE_RESOURCE).read_bytes()


@lru_cache(maxsize=1)
def _material_order_schema() -> tuple[float, float, tuple[_FieldDefinition, ...]]:
    reader = PdfReader(BytesIO(_source_pdf_bytes()))
    if len(reader.pages) != 1:
        raise RuntimeError("Die Materialschein-Vorlage muss genau eine Seite enthalten.")
    page = reader.pages[0]
    width = round(float(page.mediabox.width), 4)
    height = round(float(page.mediabox.height), 4)
    widgets = _page_widgets(page)

    direct_widgets: dict[str, DictionaryObject] = {}
    checkbox_widgets: list[DictionaryObject] = []
    for widget in widgets:
        parent = _resolve(widget.get("/Parent"))
        name = widget.get("/T") or (parent.get("/T") if parent else None)
        field_type = widget.get("/FT") or (parent.get("/FT") if parent else None)
        if field_type == "/Btn" and name == "Kontrollkästchen25":
            checkbox_widgets.append(widget)
            continue
        if isinstance(name, str):
            if name in direct_widgets:
                raise RuntimeError(f"Doppeltes PDF-Textfeld in der Vorlage: {name}")
            direct_widgets[name] = widget

    definitions: list[_FieldDefinition] = []
    for name, label, source_name, max_length in _HEADER_SOURCE_FIELDS:
        source_widget = _required_widget(direct_widgets, source_name)
        style = _source_text_style(source_widget) if name == "commission" else {}
        definitions.append(
            _definition_from_widget(
                name,
                label,
                "text",
                source_widget,
                height,
                max_length,
                **style,
            )
        )

    ordered_checkboxes = sorted(
        checkbox_widgets,
        key=lambda widget: float(widget["/Rect"][3]),
        reverse=True,
    )
    if len(ordered_checkboxes) != MATERIAL_ORDER_ROW_COUNT:
        raise RuntimeError(
            "Die Materialschein-Vorlage enthält nicht genau 23 Gepackt-Checkboxen."
        )

    for row in range(1, MATERIAL_ORDER_ROW_COUNT + 1):
        order_number_source = (
            f"Stück MeterRow{row}x{row}"
            if row < MATERIAL_ORDER_ROW_COUNT
            else "Stück MeterRow23x24"
        )
        definitions.extend(
            (
                _definition_from_widget(
                    f"material_{row}",
                    f"Material, Zeile {row}",
                    "text",
                    _required_widget(direct_widgets, f"MaterialRow{row}"),
                    height,
                    180,
                ),
                _definition_from_widget(
                    f"order_number_{row}",
                    f"Bestell-Nr., Zeile {row}",
                    "text",
                    _required_widget(direct_widgets, order_number_source),
                    height,
                    80,
                ),
                _definition_from_widget(
                    f"quantity_{row}",
                    f"Stück, Zeile {row}",
                    "text",
                    _required_widget(direct_widgets, f"Stück MeterRow{row}"),
                    height,
                    32,
                ),
                _definition_from_widget(
                    f"meters_{row}",
                    f"Meter, Zeile {row}",
                    "text",
                    _required_widget(direct_widgets, f"Stück MeterRow{row}_2"),
                    height,
                    32,
                ),
                _definition_from_widget(
                    f"packed_{row}",
                    f"Gepackt, Zeile {row}",
                    "checkbox",
                    ordered_checkboxes[row - 1],
                    height,
                    None,
                ),
            )
        )

    if len(definitions) != 6 + (MATERIAL_ORDER_ROW_COUNT * 5):
        raise RuntimeError("Unerwartete Feldanzahl in der Materialschein-Vorlage.")
    return width, height, tuple(definitions)


def _required_widget(
    widgets: Mapping[str, DictionaryObject], source_name: str
) -> DictionaryObject:
    try:
        return widgets[source_name]
    except KeyError as error:
        raise RuntimeError(
            f"Erwartetes PDF-Feld fehlt in der Materialschein-Vorlage: {source_name}"
        ) from error


def _definition_from_widget(
    name: str,
    label: str,
    field_type: Literal["text", "checkbox"],
    widget: DictionaryObject,
    page_height: float,
    max_length: int | None,
    *,
    font_size: float | None = None,
    text_color: tuple[float, float, float] | None = None,
    text_align: Literal["left", "center", "right"] | None = None,
) -> _FieldDefinition:
    x1, y1, x2, y2 = (float(value) for value in widget["/Rect"])
    return _FieldDefinition(
        name=name,
        label=label,
        type=field_type,
        rect=(
            round(x1, 3),
            round(page_height - y2, 3),
            round(x2 - x1, 3),
            round(y2 - y1, 3),
        ),
        max_length=max_length,
        font_size=font_size,
        text_color=text_color,
        text_align=text_align,
    )


def _source_text_style(widget: DictionaryObject) -> dict[str, object]:
    """Extract the commission emphasis from the supplied master widget."""

    default_appearance = widget.get("/DA")
    if not isinstance(default_appearance, str):
        raise RuntimeError("Das Kommissionsfeld besitzt keine gültige PDF-Textdarstellung.")
    tokens = default_appearance.split()
    try:
        font_operator = tokens.index("Tf")
        color_operator = tokens.index("rg")
        font_size = float(tokens[font_operator - 1])
        text_color = tuple(float(value) for value in tokens[color_operator - 3 : color_operator])
    except (ValueError, IndexError) as error:
        raise RuntimeError(
            "Die Textdarstellung des Kommissionsfeldes entspricht nicht der Vorlage."
        ) from error
    if len(text_color) != 3 or not all(0 <= value <= 1 for value in text_color):
        raise RuntimeError("Das Kommissionsfeld besitzt keine gültige PDF-RGB-Farbe.")

    alignment = {0: "left", 1: "center", 2: "right"}.get(int(widget.get("/Q", 0)))
    if alignment is None:
        raise RuntimeError("Das Kommissionsfeld besitzt eine unbekannte Textausrichtung.")
    return {
        "font_size": font_size,
        "text_color": text_color,
        "text_align": alignment,
    }


def _page_widgets(page: DictionaryObject) -> list[DictionaryObject]:
    annotations = _resolve(page.get("/Annots")) or []
    return [
        annotation
        for reference in annotations
        if (annotation := _resolve(reference)).get("/Subtype") == "/Widget"
    ]


def _resolve(value):
    return value.get_object() if isinstance(value, IndirectObject) else value


@lru_cache(maxsize=1)
def _normalized_template_pdf() -> bytes:
    reader = PdfReader(BytesIO(_source_pdf_bytes()))
    width, height, definitions = _material_order_schema()
    writer = PdfWriter()
    page = deepcopy(reader.pages[0])
    for key in ("/Annots", "/AA"):
        page.pop(NameObject(key), None)
    writer.add_page(page)
    _normalize_table_background(writer)
    for key in ("/AcroForm", "/Names", "/OpenAction", "/AA"):
        writer._root_object.pop(NameObject(key), None)
    _add_normalized_form(writer, definitions, width, height)

    output = BytesIO()
    writer.write(output)
    content = output.getvalue()
    _verify_pdf(content, _blank_values(definitions))
    return content


def _normalize_table_background(writer: PdfWriter) -> None:
    """Overlay a coherent table palette without rewriting the supplied master.

    The master draws its body grid as hundreds of 0.48-point filled rectangles,
    mixing cyan edges in the material column with black edges elsewhere.  Its
    pale-blue alternating fill also stops after the material column.  The body
    contains no static text, so a tightly bounded opaque overlay can safely
    replace only that artwork while all form widgets remain above the page
    content.  Header labels and the original header fill remain untouched.
    """

    left = TABLE_COLUMN_BOUNDARIES[0]
    right = TABLE_COLUMN_BOUNDARIES[-1]
    top = TABLE_ROW_BOUNDARIES[0]
    bottom = TABLE_ROW_BOUNDARIES[-1]
    commands = [
        b"% Material-order table palette normalization",
        b"q",
        b"1 g",
        _pdf_rectangle(left, bottom, right - left, top - bottom),
        b"f",
        (
            " ".join(f"{component:g}" for component in TABLE_PALE_BLUE) + " rg"
        ).encode("ascii"),
    ]

    for row_number in range(2, MATERIAL_ORDER_ROW_COUNT + 1, 2):
        upper = TABLE_ROW_BOUNDARIES[row_number - 1]
        lower = TABLE_ROW_BOUNDARIES[row_number]
        commands.extend(
            (
                _pdf_rectangle(left, lower, right - left, upper - lower),
                b"f",
            )
        )

    commands.append(f"{TABLE_GRID_COLOR:g} g".encode("ascii"))
    for boundary in TABLE_ROW_BOUNDARIES:
        commands.extend(
            (
                _pdf_rectangle(
                    left,
                    boundary,
                    right - left,
                    TABLE_LINE_WIDTH,
                ),
                b"f",
            )
        )
    for boundary in TABLE_COLUMN_BOUNDARIES[:-1]:
        commands.extend(
            (
                _pdf_rectangle(
                    boundary,
                    bottom,
                    TABLE_LINE_WIDTH,
                    top - bottom + TABLE_LINE_WIDTH,
                ),
                b"f",
            )
        )

    # Preserve the master's open header layout and static labels.  Only cover
    # its three cyan material-header edges with the same black 0.48-point grid.
    commands.extend(
        (
            _pdf_rectangle(
                left,
                TABLE_HEADER_TOP,
                TABLE_COLUMN_BOUNDARIES[1] - left + TABLE_LINE_WIDTH,
                TABLE_LINE_WIDTH,
            ),
            b"f",
            _pdf_rectangle(
                left,
                top + TABLE_LINE_WIDTH,
                TABLE_LINE_WIDTH,
                TABLE_HEADER_TOP - top - TABLE_LINE_WIDTH,
            ),
            b"f",
            _pdf_rectangle(
                TABLE_COLUMN_BOUNDARIES[1],
                top + TABLE_LINE_WIDTH,
                TABLE_LINE_WIDTH,
                TABLE_HEADER_TOP - top - TABLE_LINE_WIDTH,
            ),
            b"f",
            b"Q",
        )
    )

    overlay = DecodedStreamObject()
    overlay.set_data(b"\n".join(commands) + b"\n")
    overlay_reference = writer._add_object(overlay)
    page = writer.pages[0]
    existing_contents = page.get("/Contents")
    if isinstance(existing_contents, ArrayObject):
        existing_contents.append(overlay_reference)
    elif existing_contents is not None:
        page[NameObject("/Contents")] = ArrayObject(
            [existing_contents, overlay_reference]
        )
    else:
        page[NameObject("/Contents")] = overlay_reference


def _pdf_rectangle(x: float, y: float, width: float, height: float) -> bytes:
    return f"{x:g} {y:g} {width:g} {height:g} re".encode("ascii")


def _add_normalized_form(
    writer: PdfWriter,
    definitions: tuple[_FieldDefinition, ...],
    page_width: float,
    page_height: float,
) -> None:
    page = writer.pages[0]
    font = writer._add_object(
        DictionaryObject(
            {
                NameObject("/Type"): NameObject("/Font"),
                NameObject("/Subtype"): NameObject("/Type1"),
                NameObject("/BaseFont"): NameObject("/Helvetica"),
                NameObject("/Encoding"): NameObject("/WinAnsiEncoding"),
            }
        )
    )
    resources_dict = DictionaryObject(
        {NameObject("/Font"): DictionaryObject({NameObject("/Helv"): font})}
    )
    field_refs = ArrayObject()
    form = DictionaryObject(
        {
            NameObject("/Fields"): field_refs,
            NameObject("/DR"): resources_dict,
            NameObject("/DA"): TextStringObject("/Helv 0 Tf 0 g"),
            NameObject("/NeedAppearances"): BooleanObject(False),
        }
    )
    writer._root_object[NameObject("/AcroForm")] = writer._add_object(form)
    annotations = ArrayObject()
    page[NameObject("/Annots")] = annotations

    for definition in definitions:
        x, top, field_width, field_height = definition.rect
        if not (
            0 <= x < x + field_width <= page_width
            and 0 <= top < top + field_height <= page_height
        ):
            raise RuntimeError(f"PDF-Feld liegt außerhalb der Seite: {definition.name}")
        y = page_height - top - field_height
        widget = DictionaryObject(
            {
                NameObject("/Type"): NameObject("/Annot"),
                NameObject("/Subtype"): NameObject("/Widget"),
                NameObject("/FT"): NameObject("/Btn" if definition.type == "checkbox" else "/Tx"),
                NameObject("/T"): TextStringObject(definition.name),
                NameObject("/TU"): TextStringObject(definition.label),
                NameObject("/Rect"): ArrayObject(
                    [
                        FloatObject(x),
                        FloatObject(y),
                        FloatObject(x + field_width),
                        FloatObject(y + field_height),
                    ]
                ),
                NameObject("/P"): page.indirect_reference,
                NameObject("/F"): NumberObject(4),
                NameObject("/Ff"): NumberObject(0),
                NameObject("/Border"): ArrayObject([NumberObject(0)] * 3),
            }
        )
        if definition.type == "checkbox":
            off_appearance = writer._add_object(
                _checkbox_appearance(field_width, field_height, checked=False)
            )
            on_appearance = writer._add_object(
                _checkbox_appearance(field_width, field_height, checked=True)
            )
            widget.update(
                {
                    NameObject("/V"): NameObject(CHECKBOX_OFF_VALUE),
                    NameObject("/AS"): NameObject(CHECKBOX_OFF_VALUE),
                    NameObject("/AP"): DictionaryObject(
                        {
                            NameObject("/N"): DictionaryObject(
                                {
                                    NameObject(CHECKBOX_OFF_VALUE): off_appearance,
                                    NameObject(CHECKBOX_ON_VALUE): on_appearance,
                                }
                            )
                        }
                    ),
                }
            )
        else:
            appearance = DecodedStreamObject()
            appearance.set_data(b"")
            appearance.update(
                {
                    NameObject("/Type"): NameObject("/XObject"),
                    NameObject("/Subtype"): NameObject("/Form"),
                    NameObject("/BBox"): ArrayObject(
                        [FloatObject(value) for value in (0, 0, field_width, field_height)]
                    ),
                    NameObject("/Resources"): resources_dict,
                }
            )
            widget.update(
                {
                    # Size zero keeps the field auto-sizing when a user edits
                    # the returned interactive PDF in a regular PDF viewer.
                    NameObject("/DA"): TextStringObject(
                        _default_text_appearance(definition)
                    ),
                    NameObject("/V"): TextStringObject(""),
                    NameObject("/AP"): DictionaryObject(
                        {NameObject("/N"): writer._add_object(appearance)}
                    ),
                }
            )
            if definition.text_align is not None:
                widget[NameObject("/Q")] = NumberObject(
                    {"left": 0, "center": 1, "right": 2}[definition.text_align]
                )
            if definition.max_length is not None:
                widget[NameObject("/MaxLen")] = NumberObject(definition.max_length)

        reference = writer._add_object(widget)
        field_refs.append(reference)
        annotations.append(reference)

    writer.update_page_form_field_values(
        page,
        _pypdf_values(_blank_values(definitions)),
        auto_regenerate=False,
    )


def _default_text_appearance(definition: _FieldDefinition) -> str:
    font_size = definition.font_size if definition.font_size is not None else 0
    if definition.text_color is None:
        color = "0 g"
    else:
        color = " ".join(f"{component:g}" for component in definition.text_color) + " rg"
    return f"/Helv {font_size:g} Tf {color}"


def _checkbox_appearance(width: float, height: float, *, checked: bool) -> DecodedStreamObject:
    appearance = DecodedStreamObject()
    box = (
        f"q 1 1 1 rg 0 G 0.8 w 0.5 0.5 {width - 1:.3f} {height - 1:.3f} re B "
    )
    if checked:
        commands = (
            box
            + f"1.35 w 0 G 2 2 m {width - 2:.3f} {height - 2:.3f} l S "
            f"2 {height - 2:.3f} m {width - 2:.3f} 2 l S Q"
        ).encode("ascii")
    else:
        commands = (box + "Q").encode("ascii")
    appearance.set_data(commands)
    appearance.update(
        {
            NameObject("/Type"): NameObject("/XObject"),
            NameObject("/Subtype"): NameObject("/Form"),
            NameObject("/BBox"): ArrayObject(
                [FloatObject(value) for value in (0, 0, width, height)]
            ),
            NameObject("/Resources"): DictionaryObject(),
        }
    )
    return appearance


def _blank_values(
    definitions: tuple[_FieldDefinition, ...],
) -> dict[str, str | bool]:
    return {
        field.name: False if field.type == "checkbox" else "" for field in definitions
    }


def _validate_values(values: Mapping[str, str | bool]) -> dict[str, str | bool]:
    if not isinstance(values, Mapping):
        raise MaterialOrderPdfValidationError("Materialschein-Werte müssen ein Mapping sein.")
    _, _, definitions = _material_order_schema()
    definitions_by_name = {field.name: field for field in definitions}
    unknown = sorted(set(values) - set(definitions_by_name))
    if unknown:
        raise MaterialOrderPdfValidationError(
            f"Unbekannte Materialschein-Felder: {', '.join(unknown)}"
        )

    normalized = _blank_values(definitions)
    for name, value in values.items():
        definition = definitions_by_name[name]
        if definition.type == "checkbox":
            if not isinstance(value, bool):
                raise MaterialOrderPdfValidationError(
                    f"Checkbox-Feld {name} erwartet einen booleschen Wert."
                )
        else:
            if not isinstance(value, str):
                raise MaterialOrderPdfValidationError(
                    f"Textfeld {name} erwartet eine Zeichenkette."
                )
            if any(ord(character) < 32 or ord(character) == 127 for character in value):
                raise MaterialOrderPdfValidationError(
                    f"Textfeld {name} enthält nicht druckbare Steuerzeichen."
                )
            try:
                value.encode("cp1252")
            except UnicodeEncodeError as error:
                raise MaterialOrderPdfValidationError(
                    f"Textfeld {name} enthält Zeichen außerhalb des PDF-Zeichensatzes."
                ) from error
            if definition.max_length is not None and len(value) > definition.max_length:
                raise MaterialOrderPdfValidationError(
                    f"Textfeld {name} erlaubt höchstens {definition.max_length} Zeichen."
                )
            _fitted_font_size(definition, value)
        normalized[name] = value
    return normalized


def _fitted_font_size(definition: _FieldDefinition, value: str) -> float:
    maximum_font_size = definition.font_size or DEFAULT_TEXT_FONT_SIZE
    if not value:
        return maximum_font_size
    available_width = max(definition.rect[2] - 4, 1)
    text_width_at_one_point = stringWidth(value, "Helvetica", 1)
    fitted_size = min(
        maximum_font_size,
        available_width / max(text_width_at_one_point, 0.001),
    )
    if fitted_size < MINIMUM_TEXT_FONT_SIZE:
        raise MaterialOrderPdfValidationError(
            f"Textfeld {definition.name} ist für den verfügbaren PDF-Bereich zu lang."
        )
    return round(fitted_size, 2)


def _pypdf_values(
    values: Mapping[str, str | bool],
    *,
    fit_text: bool = False,
) -> dict[str, str | tuple[str, str, float]]:
    definitions = {field.name: field for field in _material_order_schema()[2]}
    result: dict[str, str | tuple[str, str, float]] = {}
    for name, value in values.items():
        if isinstance(value, bool):
            result[name] = CHECKBOX_ON_VALUE if value else CHECKBOX_OFF_VALUE
        elif fit_text:
            result[name] = (value, "/Helv", _fitted_font_size(definitions[name], value))
        else:
            result[name] = value
    return result


def _verify_pdf(content: bytes, expected_values: Mapping[str, str | bool]) -> None:
    reader = PdfReader(BytesIO(content))
    if len(reader.pages) != 1:
        raise RuntimeError("Erzeugter Materialschein enthält nicht genau eine Seite.")
    root = _resolve(reader.trailer["/Root"])
    if any(key in root for key in ("/Names", "/OpenAction", "/AA")):
        raise RuntimeError("Erzeugter Materialschein enthält aktive Dokumentaktionen.")

    fields = reader.get_fields() or {}
    if set(fields) != set(expected_values):
        raise RuntimeError("Erzeugter Materialschein enthält unerwartete Formularfelder.")
    for name, expected in expected_values.items():
        actual = fields[name].get("/V", "")
        if isinstance(expected, bool):
            expected = CHECKBOX_ON_VALUE if expected else CHECKBOX_OFF_VALUE
        if str(actual) != expected:
            raise RuntimeError(f"PDF-Feldwert wurde nicht korrekt gespeichert: {name}")

    widgets = _page_widgets(reader.pages[0])
    if len(widgets) != len(expected_values):
        raise RuntimeError("Erzeugter Materialschein enthält unerwartete PDF-Widgets.")
    widget_names: set[str] = set()
    for widget in widgets:
        name = widget.get("/T")
        if not isinstance(name, str) or name in widget_names or widget.get("/Parent"):
            raise RuntimeError("PDF-Widgets sind nicht unabhängig oder nicht eindeutig benannt.")
        widget_names.add(name)
        appearance = _resolve(widget.get("/AP"))
        normal = _resolve(appearance.get("/N")) if appearance else None
        if normal is None:
            raise RuntimeError(f"PDF-Feld besitzt keine Normaldarstellung: {name}")
        if widget.get("/FT") == "/Btn":
            state = widget.get("/AS")
            selected_appearance = _resolve(normal.get(state)) if state in normal else None
            if selected_appearance is None or not selected_appearance.get_data():
                raise RuntimeError(f"Checkbox besitzt keine druckbare Darstellung: {name}")
        elif not normal.get_data():
            raise RuntimeError(f"Textfeld besitzt keine druckbare Darstellung: {name}")
