from datetime import datetime
from types import SimpleNamespace
from zoneinfo import ZoneInfo

from app.services.photo_filename import (
    build_photo_filename,
    extra_work_photo_document_label,
    measurement_photo_document_label,
)


def test_build_photo_filename_keeps_umlauts_sanitizes_parts_and_adds_suffix():
    filename = build_photo_filename(
        date=datetime(2026, 6, 13, 10, 30, tzinfo=ZoneInfo("Europe/Berlin")),
        site_name='Schüchtermann / Klinik: A.B "Nord"',
        document_label="ZusatzauftragZ304",
        creator_name="Christopher  Erichsen",
        extension="jpeg",
        existing_names={
            "260613_Schüchtermann_Klinik_A_B_Nord_ZusatzauftragZ304_Christopher_Erichsen.jpg",
        },
    )

    assert filename == (
        "260613_Schüchtermann_Klinik_A_B_Nord_"
        "ZusatzauftragZ304_Christopher_Erichsen_02.jpg"
    )


def test_build_photo_filename_omits_empty_document_label():
    filename = build_photo_filename(
        date=datetime(2026, 6, 13, 10, 30, tzinfo=ZoneInfo("Europe/Berlin")),
        site_name="Schüchtermann Klinik",
        document_label=None,
        creator_name="Christopher Erichsen",
        extension=".png",
        existing_names=set(),
    )

    assert filename == "260613_Schüchtermann_Klinik_Christopher_Erichsen.png"


def test_photo_document_labels_use_domain_numbers():
    batch = SimpleNamespace(number=21)
    ticket = SimpleNamespace(
        id=4,
        display_number="8007.SZ04",
        site=SimpleNamespace(site_number="8007"),
    )

    assert measurement_photo_document_label(batch) == "Aufmaß21"
    assert extra_work_photo_document_label(ticket) == "ZusatzauftragSZ04"
