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
    assert result.items[0].list_minutes_total == Decimal("2238.75")
    assert result.items[1].list_quantity == Decimal("0.00")
    assert result.items[1].is_nep is True
    assert result.items[1].list_minutes_total is None
    assert "Quertraverse bis 400 mm" in result.items[3].description
