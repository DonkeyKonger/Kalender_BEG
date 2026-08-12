from decimal import Decimal
from io import BytesIO

from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from app.services.measurement_timesheet_parser import (
    parse_measurement_timesheet_lines,
    parse_measurement_timesheet_pdf,
)


def _pdf_text(value: str) -> str:
    return value.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def _build_timesheet_7282_regression_pdf() -> bytes:
    writer = PdfWriter()
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
            NameObject("/Encoding"): NameObject("/WinAnsiEncoding"),
        }
    )
    font_reference = writer._add_object(font)

    sections = [
        (
            "02.01.02",
            "Einbaugeraete Bruestungskanal",
            [
                (
                    "02.01.02. 1",
                    "Steckdoseneinheit Modul 45 1fach",
                    "54,00",
                    "STCK",
                    "0,00",
                    "0,00",
                ),
                (
                    "02.01.02. 2",
                    "Steckdoseneinheit Modul 45 2fach",
                    "1.291,00",
                    "STCK",
                    "0,00",
                    "0,00",
                ),
                (
                    "02.01.02. 3",
                    "Steckdoseneinheit Modul 45 3fach",
                    "13,00",
                    "STCK",
                    "0,00",
                    "0,00",
                ),
                ("02.01.02. 4", "Multimediatraeger HDMI", "214,00", "STCK", "0,00", "0,00"),
            ],
        ),
        (
            "02.01.05",
            "Unterflur-Geraete",
            [
                (
                    ("02.01.05.", "010"),
                    ("UD Unterflurdose liefern und montieren", "mehrzeilige Beschreibung"),
                    "15,00",
                    "Stck",
                    "31,50",
                    "472,50",
                ),
                (
                    ("02.01.05.", "020"),
                    "UD Unterflurdose liefern und montieren",
                    "16,00",
                    "Stck",
                    "31,50",
                    "504,00",
                ),
                (
                    ("02.01.05.", "030"),
                    "UZD Unterflurzugdose liefern und montieren",
                    "11,00",
                    "Stck",
                    "40,50",
                    "445,50",
                ),
                (("02.01.05.", "040"), "Steckdose 1fach", "45,00", "STCK", "0,00", "0,00"),
                (("02.01.05.", "050"), "Steckdose rot", "37,00", "STCK", "0,00", "0,00"),
                (("02.01.05.", "060"), "Multimediatraeger Audio", "8,00", "STCK", "0,00", "0,00"),
                (("02.01.05.", "070"), "Geraeteaufnahme", "45,00", "STCK", "0,00", "0,00"),
                (
                    ("02.01.05.", "080"),
                    "Daten-Geraeteanschlussmodul",
                    "90,00",
                    "STCK",
                    "0,00",
                    "0,00",
                ),
            ],
        ),
        (
            "02.02.02",
            "Kabelrinnen",
            [
                (("02.02.02.", "010"), "Kabelrinne 100/60", "1.158,00", "m", "19,80", "22.928,40"),
                (("02.02.02.", "020"), "Kabelrinne 200/60", "402,00", "m", "20,70", "8.321,40"),
                (("02.02.02.", "030"), "Kabelrinne 300/60", "736,00", "m", "21,15", "15.566,40"),
                (("02.02.02.", "040"), "Kabelrinne 400/60", "1.397,00", "m", "20,70", "28.917,90"),
                (("02.02.02.", "050"), "Kabelrinne 500/60", "100,00", "m", "22,50", "2.250,00"),
                (("02.02.02.", "060"), "Kabelrinne 600/60", "53,00", "m", "22,50", "1.192,50"),
                (
                    ("02.02.02.010", "-060a"),
                    "Mehrpreis Kabelrinnen",
                    "116,00",
                    "Stck",
                    "18,00",
                    "NEP",
                ),
                (
                    ("02.02.02.010", "-060B"),
                    "Mehrpreis Kantenschutzblech",
                    "1,00",
                    "Stck",
                    "8,10",
                    "NEP",
                ),
            ],
        ),
        (
            "02.02.03",
            "Bruestungskanal",
            [
                (
                    ("02.02.03.", "010"),
                    "Aluminium-Bruestungskanal",
                    "2.625,00",
                    "m",
                    "15,30",
                    "40.162,50",
                ),
                *[
                    (
                        ("02.02.03.", f"010{suffix}"),
                        f"Formteil {suffix}",
                        "1,00",
                        "STCK",
                        "0,00",
                        "NEP",
                    )
                    for suffix in "abcdefgh"
                ],
                (
                    ("02.02.03.", "020"),
                    "Bohrungen herstellen",
                    "1.271,00",
                    "Stck",
                    "9,00",
                    "11.439,00",
                ),
                (("02.02.03.", "021"), "Nachlass", "1,00", "Stck", "0,00", "0,00"),
            ],
        ),
        (
            "02.02.04",
            "Steigetrassen",
            [
                ("02.02.04. 1", "Steigeleiter 200/60", "120,00", "m", "19,80", "2.376,00"),
                ("02.02.04. 2", "Steigeleiter 400/60", "40,00", "m", "21,15", "846,00"),
                ("02.02.04. 3", "Steigeleiter 600/60", "198,00", "m", "22,50", "4.455,00"),
                (("02.02.04.1-", "3A"), "Mehrpreis Chemieduebel", "1,00", "Stck", "6,30", "NEP"),
            ],
        ),
        (
            "02.02.06",
            "Unterflur-Kanal",
            [
                (("02.02.06.", "020"), "Fussbodenkanal", "287,00", "m", "16,20", "4.649,40"),
            ],
        ),
        (
            "02.02.06.",
            "Ankerschienen",
            [
                (
                    "02.02.06..1A",
                    "CML-Schiene 35/18 bis 1,0 m liefern und montieren",
                    "400,00",
                    "Stck",
                    "12,15",
                    "4.860,00",
                ),
                ("02.02.06..1B", "CML-Schiene 35/18 bis 0,5 m", "1,00", "Stck", "11,25", "NEP"),
                ("02.02.06..1C", "CML-Schiene 35/18 bis 0,3 m", "1,00", "Stck", "10,71", "NEP"),
                (("02.02.06..1-", "3A"), "Mehrpreis Chemieduebel", "1,00", "Stck", "6,30", "NEP"),
            ],
        ),
    ]

    page_rows = [[], [], []]
    for section, title, rows in sections:
        target_page = 0 if section in {"02.01.02", "02.01.05"} else None
        if section == "02.02.02":
            page_rows[0].append(("heading", section, title))
            page_rows[0].extend(("item", *row) for row in rows[:2])
            page_rows[1].extend(("item", *row) for row in rows[2:])
            continue
        if section == "02.02.03":
            page_rows[1].append(("heading", section, title))
            page_rows[1].extend(("item", *row) for row in rows[:-1])
            page_rows[2].extend(("item", *row) for row in rows[-1:])
            continue
        if target_page is None:
            target_page = 2
        page_rows[target_page].append(("heading", section, title))
        page_rows[target_page].extend(("item", *row) for row in rows)

    def add_text(commands: list[str], x: float, y: float, text: str) -> None:
        commands.append(f"BT /F1 7 Tf 1 0 0 1 {x} {y} Tm ({_pdf_text(text)}) Tj ET")

    for page_index, rows in enumerate(page_rows):
        page = writer.add_blank_page(width=595.33, height=841.78)
        page[NameObject("/Resources")] = DictionaryObject(
            {NameObject("/Font"): DictionaryObject({NameObject("/F1"): font_reference})}
        )
        commands: list[str] = []
        if page_index == 0:
            add_text(commands, 58, 790, "Zeit-Vorgabeliste")
            add_text(commands, 58, 770, "Projekt = 7282/P250216")
            add_text(commands, 58, 758, "Rechnung = 4250107")
            add_text(commands, 58, 746, "Name1 = Karl H. Preusse")
            add_text(commands, 69, 720, "Position")
            add_text(commands, 203, 720, "Bezeichnung")
            add_text(commands, 372, 720, "Menge")
            add_text(commands, 429, 720, "Minuten / Einheit")
            add_text(commands, 502, 720, "Minuten gesamt")
            y = 690
        else:
            y = 730

        for row in rows:
            if row[0] == "heading":
                _, position, description = row
                add_text(commands, 58, y, position)
                add_text(commands, 117, y, description)
                add_text(commands, 540, y, "0,00")
                y -= 22
                continue

            _, position, description, quantity, unit, minutes_per_unit, minutes_total = row
            position_fragments = position if isinstance(position, tuple) else (position,)
            description_lines = description if isinstance(description, tuple) else (description,)
            add_text(commands, 58, y, position_fragments[0])
            add_text(commands, 117, y, description_lines[0])
            add_text(commands, 360, y, quantity)
            add_text(commands, 385, y, unit)
            add_text(commands, 475, y, minutes_per_unit)
            add_text(commands, 540, y, minutes_total)
            for offset, fragment in enumerate(position_fragments[1:], start=1):
                add_text(commands, 58, y - 10 * offset, fragment)
            for offset, description_line in enumerate(description_lines[1:], start=1):
                add_text(commands, 117, y - 10 * offset, description_line)
            y -= 28

        stream = DecodedStreamObject()
        stream.set_data("\n".join(commands).encode("cp1252"))
        page[NameObject("/Contents")] = writer._add_object(stream)

    output = BytesIO()
    writer.write(output)
    return output.getvalue()


def test_parse_measurement_timesheet_lines_keeps_zero_quantities_and_split_positions():
    result = parse_measurement_timesheet_lines(
        [
            "Zeit-Vorgabeliste",
            "Projekt = 8007 / P250092",
            "Rechnung = 1260197",
            "Name1 = ebm elektro-bau-",
            "montage GmbH",
            "Position Bezeichnung Menge Minuten / Einheit Minuten gesamt",
            "1.01.05 Kabelrinnen 12.059,33",
            "1.01.05. FS 1,5 mm Kabelrinne 400/60 mm liefern und 199,00 m 11,25 2.238,75",
            "140a montieren",
            "1.01.05.160 90°Rinnenbogen 500/60 mm FT liefern und montieren 0,00 Stck 17,10 NEP",
            "N1 Neue Leistungen Funktionserhaltkabeltrasse 5.211,90",
            "N1. 10 Kabelrinne 300/60 mm f.Funktionserhalt 333,00 m 9,90 3.296,70",
            "N3.1 Pendelabhängung für Zwischendeckenmontage 1.152,00",
            "N3.1. 10 Pendelabhängung bis 0,7 m inkl. Quertraverse bis 400 32,00 st 36,00 1.152,00",
            "mm als komplette betriebsfertige Einheit liefern und montieren,",
            "N4.2. 20 Stielausleger 200 mm mit Adapter für Gewindestange liefern und montieren 15,00 st 4,05 60,75",
        ]
    )

    assert result.source_project_number == "8007 / P250092"
    assert result.source_invoice_number == "1260197"
    assert result.source_customer_name == "ebm elektro-bau-montage GmbH"
    assert [item.position for item in result.items] == [
        "1.01.05.140a",
        "1.01.05.160",
        "N1.10",
        "N3.1.10",
        "N4.2.20",
    ]
    assert result.items[0].list_quantity == Decimal("199.00")
    assert result.items[0].source_section_key == "1.01.05"
    assert result.items[0].source_section_title == "Kabelrinnen"
    assert result.items[0].list_minutes_total == Decimal("2238.75")
    assert result.items[1].list_quantity == Decimal("0.00")
    assert result.items[1].is_nep is True
    assert result.items[1].list_minutes_total is None
    assert "Quertraverse bis 400 mm" in result.items[3].description


def test_parse_measurement_timesheet_lines_synthesizes_repeated_simple_positions():
    result = parse_measurement_timesheet_lines(
        [
            "Zeit-Vorgabeliste",
            "Projekt = 8007 / P250092",
            "Rechnung = 1260198",
            "Name1 = ebm elektro-bau-montage GmbH",
            "Position Bezeichnung Menge Minuten / Einheit Minuten gesamt",
            "1 Nidax Verlegesysteme 1.395,00",
            "1. U-Stiel bis 400 mm liefern und montieren 42,00 ST 16,00 672,00",
            "1. Stielausleger 100 mm liefern und montieren 42,00 ST 4,00 168,00",
            "1. Kabelrinne 100/60 mm liefern und montieren 60,00 m 8,00 480,00",
            "1. 90° Rinnenbogen 100/60 mm liefern und montieren 5,00 ST 15,00 75,00",
            "gesamt: 1.395,00",
        ]
    )

    assert [item.position for item in result.items] == ["1.1", "1.2", "1.3", "1.4"]
    assert [item.source_section_key for item in result.items] == ["1", "1", "1", "1"]
    assert [item.source_section_title for item in result.items] == [
        "Nidax Verlegesysteme",
        "Nidax Verlegesysteme",
        "Nidax Verlegesysteme",
        "Nidax Verlegesysteme",
    ]
    assert [item.description for item in result.items] == [
        "U-Stiel bis 400 mm liefern und montieren",
        "Stielausleger 100 mm liefern und montieren",
        "Kabelrinne 100/60 mm liefern und montieren",
        "90° Rinnenbogen 100/60 mm liefern und montieren",
    ]
    assert [item.list_quantity for item in result.items] == [
        Decimal("42.00"),
        Decimal("42.00"),
        Decimal("60.00"),
        Decimal("5.00"),
    ]
    assert [item.unit for item in result.items] == ["ST", "ST", "m", "ST"]
    assert [item.minutes_per_unit for item in result.items] == [
        Decimal("16.00"),
        Decimal("4.00"),
        Decimal("8.00"),
        Decimal("15.00"),
    ]
    assert [item.list_minutes_total for item in result.items] == [
        Decimal("672.00"),
        Decimal("168.00"),
        Decimal("480.00"),
        Decimal("75.00"),
    ]


def test_parse_measurement_timesheet_lines_keeps_group_headings_as_section_metadata():
    result = parse_measurement_timesheet_lines(
        [
            "Zeit-Vorgabeliste",
            "Projekt = 8005 / P240197",
            "Rechnung = 3240527",
            "Name1 = Siegfried Nass GmbH",
            "Position Bezeichnung Menge Minuten / Einheit Minuten gesamt",
            "1 Verlegesysteme 2.935,00",
            "1. 1 Weitspannkabelleiter liefern und montieren 84,00 m 25,00 2.100,00",
            "1. 2 Adapterplatte zum Anflanschen liefern und montieren 10,00 ST 22,50 225,00",
            "2 Mittelschwere Steigeleiter 210,00",
            "2. 1 Mittelschwere Steigeleiter SLM50 liefern und montieren 1,00 Stck 210,00 210,00",
            "3 Verteilereinspeisung 90,00",
            "3. 1 Sonderkonstruktion zur Einspeisung liefern 1,00 Stck 90,00 90,00",
            "gesamt: 3.235,00",
        ]
    )

    assert [item.position for item in result.items] == ["1.1", "1.2", "2.1", "3.1"]
    assert [item.description for item in result.items] == [
        "Weitspannkabelleiter liefern und montieren",
        "Adapterplatte zum Anflanschen liefern und montieren",
        "Mittelschwere Steigeleiter SLM50 liefern und montieren",
        "Sonderkonstruktion zur Einspeisung liefern",
    ]
    assert [(item.source_section_key, item.source_section_title) for item in result.items] == [
        ("1", "Verlegesysteme"),
        ("1", "Verlegesysteme"),
        ("2", "Mittelschwere Steigeleiter"),
        ("3", "Verteilereinspeisung"),
    ]


def test_parse_measurement_timesheet_lines_recognizes_extended_group_heading_formats():
    result = parse_measurement_timesheet_lines(
        [
            "Zeit-Vorgabeliste",
            "Projekt = 8007 / P250092",
            "Rechnung = 1260255",
            "Name1 = Badener Elektro GmbH",
            "Position Bezeichnung Menge Minuten / Einheit Minuten gesamt",
            "4.4.02 Verlegesysteme mittelschwer 252.715,79",
            "4.4.02. 10 Kabelrinne 100/60 mm 3530,10m 21,50 75.897,15",
            "4.4.02. 71 Abzug Rinne pro ldm. Mittelwert -41,70m 10,00 -417,00",
            "N.10 Zusatzaufträge 71.070,00",
            "N.10. 1 Monteurstunden zum Nachweis 975,00Std 60,00 58.500,00",
            "N01 Kabelleiter UG2 im Doppelboden AV Trasse 31.499,40",
            "N01. 1 I-Stiel bis 600 mm liefern und auf dem Rohfußboden 136,00ST 19,00 2.584,00",
            "N01.1 Kabelleiter UG2 im Doppelboden SV Trasse 21.749,70",
            "N01.1. 1 3-fach Konstruktion nach OBO Heißbemessung 4,00ST 95,00 380,00",
            "N01.1. Ertüchtigung Brandschutz DB UG2 gemäß PVO 11.760,00",
            "N01.1.. 1 N6.1331 82,00ST 95,00 7.790,00",
            "N02.2 zusätzliche Formteile 0,00",
            "N02.2. 8 90° Rinnenbogen 592,00ST 17,00 10.064,00",
            "N36/N104 Kennzeichnungsschilder OBO + Wichmann 0,00",
            "N36/N104. 1 Kennzeichnungsschild liefern und montieren 2,00ST 15,00 30,00",
            "N39.1. Leistungen 4. OG",
            "N39.1. 12a Wiedermontage Brüstungskanal 2,80m 60,00 168,00",
            "N39.1. Leistungen 3. OG",
            "N39.1. 13 Wiedermontage Brüstungskanal 3,00m 60,00 180,00",
        ]
    )

    assert [item.position for item in result.items] == [
        "4.4.02.10",
        "4.4.02.71",
        "N.10.1",
        "N01.1",
        "N01.1.1",
        "N01.1.1",
        "N02.2.8",
        "N36/N104.1",
        "N39.1.12a",
        "N39.1.13",
    ]
    assert result.items[1].list_quantity == Decimal("-41.70")
    assert result.items[1].list_minutes_total == Decimal("-417.00")
    assert [(item.source_section_key, item.source_section_title) for item in result.items] == [
        ("4.4.02", "Verlegesysteme mittelschwer"),
        ("4.4.02", "Verlegesysteme mittelschwer"),
        ("N.10", "Zusatzaufträge"),
        ("N01", "Kabelleiter UG2 im Doppelboden AV Trasse"),
        ("N01.1", "Kabelleiter UG2 im Doppelboden SV Trasse"),
        ("N01.1", "Ertüchtigung Brandschutz DB UG2 gemäß PVO"),
        ("N02.2", "zusätzliche Formteile"),
        ("N36/N104", "Kennzeichnungsschilder OBO + Wichmann"),
        ("N39.1", "Leistungen 4. OG"),
        ("N39.1", "Leistungen 3. OG"),
    ]


def test_parse_measurement_timesheet_pdf_reconstructs_all_7282_position_variants():
    result = parse_measurement_timesheet_pdf(_build_timesheet_7282_regression_pdf())
    positions = [item.position for item in result.items]

    expected_positions = [
        "02.01.02.1",
        "02.01.02.2",
        "02.01.02.3",
        "02.01.02.4",
        "02.01.05.010",
        "02.01.05.020",
        "02.01.05.030",
        "02.01.05.040",
        "02.01.05.050",
        "02.01.05.060",
        "02.01.05.070",
        "02.01.05.080",
        "02.02.02.010",
        "02.02.02.020",
        "02.02.02.030",
        "02.02.02.040",
        "02.02.02.050",
        "02.02.02.060",
        "02.02.02.010-060a",
        "02.02.02.010-060B",
        "02.02.03.010",
        "02.02.03.010a",
        "02.02.03.010b",
        "02.02.03.010c",
        "02.02.03.010d",
        "02.02.03.010e",
        "02.02.03.010f",
        "02.02.03.010g",
        "02.02.03.010h",
        "02.02.03.020",
        "02.02.03.021",
        "02.02.04.1",
        "02.02.04.2",
        "02.02.04.3",
        "02.02.04.1-3A",
        "02.02.06.020",
        "02.02.06..1A",
        "02.02.06..1B",
        "02.02.06..1C",
        "02.02.06..1-3A",
    ]
    assert result.source_project_number == "7282/P250216"
    assert result.source_invoice_number == "4250107"
    assert result.source_customer_name == "Karl H. Preusse"
    assert len(result.items) == 40
    assert len(set(positions)) == 40
    assert positions == expected_positions

    by_position = {item.position: item for item in result.items}
    underfloor = by_position["02.01.05.010"]
    assert underfloor.description.startswith("UD Unterflurdose liefern und montieren")
    assert "mehrzeilige Beschreibung" in underfloor.description
    assert underfloor.list_quantity == Decimal("15.00")
    assert underfloor.unit == "Stck"
    assert underfloor.minutes_per_unit == Decimal("31.50")
    assert underfloor.list_minutes_total == Decimal("472.50")

    range_nep = by_position["02.02.02.010-060a"]
    assert range_nep.description == "Mehrpreis Kabelrinnen"
    assert range_nep.list_quantity == Decimal("116.00")
    assert range_nep.unit == "Stck"
    assert range_nep.minutes_per_unit == Decimal("18.00")
    assert range_nep.list_minutes_total is None
    assert range_nep.is_nep is True

    double_dot = by_position["02.02.06..1A"]
    assert double_dot.description == "CML-Schiene 35/18 bis 1,0 m liefern und montieren"
    assert double_dot.list_quantity == Decimal("400.00")
    assert double_dot.unit == "Stck"
    assert double_dot.minutes_per_unit == Decimal("12.15")
    assert double_dot.list_minutes_total == Decimal("4860.00")
    assert double_dot.source_section_key == "02.02.06"
    assert double_dot.source_section_title == "Ankerschienen"


def test_parse_measurement_timesheet_lines_accepts_split_ranges_and_double_dot_positions():
    result = parse_measurement_timesheet_lines(
        [
            "Position Bezeichnung Menge Minuten / Einheit Minuten gesamt",
            "02.02.02.010 Mehrpreis Kabelrinnen 116,00 Stck 18,00 NEP",
            "-060a Richtungswechsel",
            "02.02.04.1- Mehrpreis Chemieduebel 1,00 Stck 6,30 NEP",
            "3A Hochleistungskleber",
            "02.02.06..1A CML-Schiene 400,00 Stck 12,15 4.860,00",
        ]
    )

    assert [item.position for item in result.items] == [
        "02.02.02.010-060a",
        "02.02.04.1-3A",
        "02.02.06..1A",
    ]
    assert result.items[0].description == "Mehrpreis Kabelrinnen Richtungswechsel"
    assert result.items[1].description == "Mehrpreis Chemieduebel Hochleistungskleber"
