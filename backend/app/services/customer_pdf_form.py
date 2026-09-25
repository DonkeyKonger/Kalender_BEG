"""Small, passive AcroForms for the customer section of unsigned documents.

Widgets and canonical fields deliberately share the same indirect object. No
template fields, JavaScript, automatic dates or signature values are imported.
"""

from dataclasses import dataclass
from io import BytesIO

from pypdf import PdfReader, PdfWriter
from pypdf.generic import (
    ArrayObject,
    BooleanObject,
    DecodedStreamObject,
    DictionaryObject,
    FloatObject,
    NameObject,
    NumberObject,
    TextStringObject,
)


@dataclass(frozen=True)
class CustomerFormField:
    name: str
    label: str
    rect: tuple[float, float, float, float]  # x, y, width, height, in PDF points
    value: str = ""
    signature: bool = False
    font_size: float = 8


def add_customer_form(writer: PdfWriter, page_index: int, fields: list[CustomerFormField]) -> None:
    """Add only the explicitly allowed customer fields to a clean document."""
    if "/AcroForm" in writer._root_object:
        raise ValueError("Customer fields must be added to a document without an existing form")
    page = writer.pages[page_index]
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
    resources = DictionaryObject(
        {NameObject("/Font"): DictionaryObject({NameObject("/Helv"): font})}
    )
    field_refs = ArrayObject()
    form = DictionaryObject(
        {
            NameObject("/Fields"): field_refs,
            NameObject("/DR"): resources,
            NameObject("/DA"): TextStringObject("/Helv 8 Tf 0 g"),
            NameObject("/NeedAppearances"): BooleanObject(False),
            NameObject("/SigFlags"): NumberObject(1),  # Signature field present, not signed yet.
        }
    )
    writer._root_object[NameObject("/AcroForm")] = writer._add_object(form)
    annotations = page.setdefault(NameObject("/Annots"), ArrayObject()).get_object()
    values = {}
    for field in fields:
        x, y, width, height = field.rect
        appearance = DecodedStreamObject()
        appearance.set_data(b"")
        appearance.update(
            {
                NameObject("/Type"): NameObject("/XObject"),
                NameObject("/Subtype"): NameObject("/Form"),
                NameObject("/BBox"): ArrayObject([FloatObject(v) for v in (0, 0, width, height)]),
                NameObject("/Resources"): resources,
            }
        )
        widget = DictionaryObject(
            {
                NameObject("/Type"): NameObject("/Annot"),
                NameObject("/Subtype"): NameObject("/Widget"),
                NameObject("/FT"): NameObject("/Sig" if field.signature else "/Tx"),
                NameObject("/T"): TextStringObject(field.name),
                NameObject("/TU"): TextStringObject(field.label),
                NameObject("/Rect"): ArrayObject(
                    [FloatObject(v) for v in (x, y, x + width, y + height)]
                ),
                NameObject("/P"): page.indirect_reference,
                NameObject("/F"): NumberObject(4),  # Print, but neither hidden nor read-only.
                NameObject("/Ff"): NumberObject(0),
                NameObject("/Border"): ArrayObject([NumberObject(0)] * 3),
                NameObject("/AP"): DictionaryObject(
                    {NameObject("/N"): writer._add_object(appearance)}
                ),
            }
        )
        if not field.signature:
            widget[NameObject("/DA")] = TextStringObject(f"/Helv {field.font_size} Tf 0 g")
            widget[NameObject("/V")] = TextStringObject(field.value)
            values[field.name] = field.value
        reference = writer._add_object(widget)
        field_refs.append(reference)
        annotations.append(reference)
    # Persist appearance streams as well as values so printing/viewing does not
    # rely on the PDF viewer regenerating fields (some mobile viewers do not).
    writer.update_page_form_field_values(page, values, auto_regenerate=False)


def measurement_customer_form(
    content: bytes,
    page_index: int,
    *,
    place: str = "",
    name: str = "",
    y_offset: float = 0,
) -> bytes:
    writer = PdfWriter(clone_from=PdfReader(BytesIO(content)))
    add_customer_form(
        writer,
        page_index,
        [
            CustomerFormField(
                "customer_place_date",
                "Ort / Datum",
                (136, 15 + y_offset, 97.5, 18),
                place,
                font_size=6.8,
            ),
            CustomerFormField(
                "customer_name",
                "Name Auftraggeber (Kunde)",
                (394.9, 15 + y_offset, 171.7, 18),
                name,
            ),
            CustomerFormField(
                "customer_signature",
                "Unterschrift Auftraggeber (Kunde)",
                (661, 17 + y_offset, 103, 24),
                signature=True,
            ),
        ],
    )
    output = BytesIO()
    writer.write(output)
    return output.getvalue()
