from app.models.enums import PersonType
from app.models.person import Person


def calendar_short_code(person: Person) -> str:
    if getattr(person, "deleted_at", None) is not None:
        return "gelöscht"
    return calendar_short_code_from_values(
        first_name=person.first_name,
        last_name=person.last_name,
        display_name=person.display_name,
        short_code=person.short_code,
        person_type=getattr(person, "person_type", PersonType.INTERNAL),
    )


def calendar_short_code_from_values(
    *,
    first_name: str | None = None,
    last_name: str | None = None,
    display_name: str | None = None,
    short_code: str | None = None,
    person_type: PersonType | str | None = PersonType.INTERNAL,
) -> str:
    display_name = (display_name or "").strip()
    short_code = (short_code or "").strip()
    if person_type not in {PersonType.INTERNAL, PersonType.INTERNAL.value, None}:
        return display_name or short_code
    return employee_short_code_from_values(
        first_name=first_name,
        last_name=last_name,
        display_name=display_name,
        short_code=short_code,
    )


def employee_short_code_from_values(
    *,
    first_name: str | None = None,
    last_name: str | None = None,
    display_name: str | None = None,
    short_code: str | None = None,
) -> str:
    display_name = (display_name or "").strip()
    short_code = (short_code or "").strip()
    display_parts = name_parts(display_name)
    if len(display_parts) >= 2:
        return f"{display_parts[0][:1]}.{display_parts[-1]}"

    first = (first_name or "").strip()
    last = (last_name or "").strip()
    if not first and not last:
        return short_code or (display_parts[0] if display_parts else display_name)
    if not first or not last:
        return short_code or first or last
    return f"{first[:1]}.{last}"


def name_parts(display_name: str) -> list[str]:
    return [part for part in display_name.strip().split() if part]
