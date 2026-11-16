from io import BytesIO

import pytest
from pypdf import PdfReader, PdfWriter

from app.services.material_order_pdf_service import (
    MaterialOrderPdfValidationError,
    build_material_order_pdf,
    get_material_order_form,
    get_material_order_template,
)


def _widgets(reader: PdfReader):
    return [
        reference.get_object()
        for reference in reader.pages[0]["/Annots"]
        if reference.get_object().get("/Subtype") == "/Widget"
    ]


def test_form_descriptor_uses_stable_names_and_top_left_pdf_points():
    form = get_material_order_form()
    assert form["width"] == 595.2755
    assert form["height"] == 841.8898
    assert len(form["fields"]) == 121

    fields = {field["name"]: field for field in form["fields"]}
    assert len(fields) == 121
    assert fields["customer"] == {
        "name": "customer",
        "label": "Kunde",
        "type": "text",
        "rect": [106.582, 129.393, 233.64, 14.173],
        "max_length": 120,
    }
    assert fields["material_1"]["rect"] == [56.693, 273.526, 257.682, 20.16]
    assert fields["order_number_1"]["rect"] == [315.213, 273.418, 55.08, 20.16]
    assert fields["quantity_1"]["rect"] == [371.994, 272.871, 55.08, 20.16]
    assert fields["meters_1"]["rect"] == [428.031, 273.526, 54.84, 20.16]
    assert fields["packed_1"]["rect"] == [510.236, 277.796, 11.339, 11.338]
    assert fields["packed_23"]["rect"] == [510.236, 752.458, 11.339, 11.339]
    assert all(
        field["type"] == ("checkbox" if field["name"].startswith("packed_") else "text")
        for field in fields.values()
    )
    assert sum(field["type"] == "checkbox" for field in fields.values()) == 23
    assert fields["material_1"]["max_length"] == 180
    assert fields["quantity_1"]["max_length"] == 32
    assert fields["packed_1"]["max_length"] is None
    assert all(
        0 <= field["rect"][0] < field["rect"][0] + field["rect"][2] <= form["width"]
        and 0 <= field["rect"][1] < field["rect"][1] + field["rect"][3] <= form["height"]
        for field in fields.values()
    )


def test_blank_template_is_passive_interactive_and_has_independent_widgets():
    content = get_material_order_template()
    reader = PdfReader(BytesIO(content))
    fields = reader.get_fields()
    widgets = _widgets(reader)
    root = reader.trailer["/Root"]

    assert len(reader.pages) == 1
    assert len(fields) == 121
    assert len(widgets) == 121
    assert len({widget["/T"] for widget in widgets}) == 121
    assert all("/Parent" not in widget for widget in widgets)
    assert all(widget["/F"] == 4 and widget["/Ff"] == 0 for widget in widgets)
    assert all(fields[f"packed_{row}"]["/V"] == "/Off" for row in range(1, 24))
    assert not root["/AcroForm"]["/NeedAppearances"].value
    assert all(key not in root for key in ("/Names", "/OpenAction", "/AA"))
    assert b"/JavaScript" not in content
    assert b"/JS" not in content

    canonical_refs = root["/AcroForm"]["/Fields"]
    annotation_refs = reader.pages[0]["/Annots"]
    assert list(canonical_refs) == list(annotation_refs)
    for widget in widgets:
        normal = widget["/AP"]["/N"]
        if widget["/FT"] == "/Btn":
            assert set(normal) == {"/Off", "/Yes"}
            assert normal["/Off"].get_data()
            assert normal["/Yes"].get_data()
            assert b" re B" in normal["/Off"].get_data()
        else:
            assert normal.get_data()


def test_build_fills_unicode_text_and_checkbox_rows_independently():
    content = build_material_order_pdf(
        {
            "customer": "Müller & Söhne GmbH",
            "project": "Nexperia Hamburg",
            "commission": "8039",
            "requested_by": "Maximilian Alexander Mustermann",
            "material_1": "Kabelrinne 200 mm",
            "order_number_1": "SKSM 620 FT",
            "quantity_1": "12",
            "meters_1": "24,5",
            "packed_1": True,
            "packed_2": False,
            "packed_23": True,
        }
    )
    reader = PdfReader(BytesIO(content))
    fields = reader.get_fields()
    assert fields["customer"]["/V"] == "Müller & Söhne GmbH"
    assert fields["material_1"]["/V"] == "Kabelrinne 200 mm"
    assert fields["packed_1"]["/V"] == "/Yes"
    assert fields["packed_2"]["/V"] == "/Off"
    assert fields["packed_23"]["/V"] == "/Yes"

    widgets = {widget["/T"]: widget for widget in _widgets(reader)}
    assert widgets["packed_1"]["/AS"] == "/Yes"
    assert widgets["packed_2"]["/AS"] == "/Off"
    assert widgets["packed_23"]["/AS"] == "/Yes"
    assert b"Tj" in widgets["customer"]["/AP"]["/N"].get_data()
    assert b"/Helv 3.22 Tf" in widgets["requested_by"]["/AP"]["/N"].get_data()
    assert widgets["packed_1"]["/AP"]["/N"]["/Yes"].get_data()

    # The returned PDF remains genuinely interactive after save/reopen.
    writer = PdfWriter(clone_from=reader)
    writer.update_page_form_field_values(
        None,
        {"customer": "Neu", "packed_1": "/Off", "packed_2": "/Yes"},
        auto_regenerate=False,
    )
    refilled = BytesIO()
    writer.write(refilled)
    reopened = PdfReader(BytesIO(refilled.getvalue()))
    assert reopened.get_fields()["customer"]["/V"] == "Neu"
    assert reopened.get_fields()["packed_1"]["/V"] == "/Off"
    assert reopened.get_fields()["packed_2"]["/V"] == "/Yes"


@pytest.mark.parametrize(
    "values, message",
    [
        ({"not_a_field": "x"}, "Unbekannte Materialschein-Felder"),
        ({"customer": True}, "Textfeld customer erwartet eine Zeichenkette"),
        ({"packed_1": "true"}, "Checkbox-Feld packed_1 erwartet einen booleschen Wert"),
        ({"customer": "x\n"}, "nicht druckbare Steuerzeichen"),
        ({"customer": "Emoji 😀"}, "außerhalb des PDF-Zeichensatzes"),
        ({"quantity_1": "x" * 33}, "höchstens 32 Zeichen"),
        ({"requested_by": "W" * 80}, "für den verfügbaren PDF-Bereich zu lang"),
    ],
)
def test_build_rejects_values_that_cannot_be_represented(values, message):
    with pytest.raises(MaterialOrderPdfValidationError, match=message):
        build_material_order_pdf(values)
