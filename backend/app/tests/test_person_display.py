from types import SimpleNamespace

from app.services.person_display import calendar_short_code


def person(first_name: str, last_name: str, display_name: str = "") -> SimpleNamespace:
    return SimpleNamespace(
        first_name=first_name,
        last_name=last_name,
        display_name=display_name or f"{first_name} {last_name}".strip(),
        short_code="Al. Ko.",
    )


def test_calendar_short_code_uses_first_initial_and_full_last_name():
    assert calendar_short_code(person("Christopher", "Erichsen")) == "C.Erichsen"


def test_calendar_short_code_uses_display_name_last_token_for_external_temp_people():
    assert calendar_short_code(person("Max Mustermann", "", "Max Mustermann")) == "M.Mustermann"


def test_calendar_short_code_handles_single_name_external_temp_people():
    assert calendar_short_code(person("Leihmann", "Leihmann", "Leihmann")) == "L.Leihmann"


def test_calendar_short_code_prefers_unicode_display_name_for_visible_label():
    assert calendar_short_code(person("Juergen", "Mueller", "Jürgen Müller")) == "J.Müller"
