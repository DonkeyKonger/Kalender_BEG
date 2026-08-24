import pytest

from app.services.extra_work_number import (
    build_extra_work_display_number,
    next_extra_work_sequence,
    parse_extra_work_sequence,
)


@pytest.mark.parametrize(
    ("display_number", "expected"),
    [
        ("9999.SZ15", 15),
        ("9999.Z16", 16),
        ("9999.SZ001", 1),
        (" 9999.Z99 ", 99),
    ],
)
def test_extra_work_number_parser_accepts_legacy_and_current_formats(
    display_number,
    expected,
):
    assert parse_extra_work_sequence(display_number, site_number="9999") == expected


@pytest.mark.parametrize(
    "display_number",
    [
        "9998.SZ15",
        "9999.AZ15",
        "9999.Z0",
        "9999.SZ15.pdf",
        "Beleg 9999.Z15",
        "9999.z15",
        "9999.SZ",
        "",
        None,
    ],
)
def test_extra_work_number_parser_rejects_other_sites_and_lookalike_documents(
    display_number,
):
    assert parse_extra_work_sequence(display_number, site_number="9999") is None


def test_new_extra_work_numbers_always_use_z_prefix():
    assert build_extra_work_display_number(" 9999 ", 1) == "9999.Z01"
    assert build_extra_work_display_number("9999", 115) == "9999.Z115"


def test_new_extra_work_number_requires_site_number_and_positive_sequence():
    with pytest.raises(ValueError, match="site number"):
        build_extra_work_display_number(None, 1)
    with pytest.raises(ValueError, match="positive"):
        build_extra_work_display_number("9999", 0)


def test_next_sequence_considers_stored_values_and_both_supported_prefixes():
    assert next_extra_work_sequence(
        site_number="9999",
        existing_numbers=[
            (3, "9999.SZ15"),
            (7, "9999.Z17"),
            (9, "9999.AZ99"),
            (12, "other-document.Z88"),
        ],
    ) == 18
