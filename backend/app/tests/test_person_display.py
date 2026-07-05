from types import SimpleNamespace

from app.models.enums import PersonType
from app.services.person_display import calendar_short_code, employee_short_code_from_values


def person(
    first_name: str,
    last_name: str,
    display_name: str = "",
    person_type: PersonType = PersonType.INTERNAL,
) -> SimpleNamespace:
    return SimpleNamespace(
        first_name=first_name,
        last_name=last_name,
        display_name=display_name or f"{first_name} {last_name}".strip(),
        short_code="Al. Ko.",
        person_type=person_type,
    )


def test_calendar_short_code_uses_first_initial_and_full_last_name():
    assert calendar_short_code(person("Christopher", "Erichsen")) == "C.Erichsen"


def test_calendar_short_code_keeps_external_display_name():
    assert calendar_short_code(person("Fridolin", "", "Fridolin", PersonType.EXTERNAL)) == "Fridolin"


def test_calendar_short_code_keeps_external_temp_display_name_with_spaces():
    assert calendar_short_code(person("Jan Tietz", "", "Jan Tietz", PersonType.EXTERNAL_TEMP)) == "Jan Tietz"


def test_calendar_short_code_prefers_unicode_display_name_for_visible_label():
    assert calendar_short_code(person("Juergen", "Mueller", "Jürgen Müller")) == "J.Müller"


def test_employee_short_code_uses_fallback_for_incomplete_name():
    assert employee_short_code_from_values(display_name="Monteur", short_code="ALT") == "ALT"
    assert employee_short_code_from_values(display_name="Monteur") == "Monteur"
