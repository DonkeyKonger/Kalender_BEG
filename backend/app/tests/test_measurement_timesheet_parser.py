from decimal import Decimal

from app.services.measurement_timesheet_parser import parse_measurement_timesheet_lines


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
