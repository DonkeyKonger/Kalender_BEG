from app.models.person import Person


def calendar_short_code(person: Person) -> str:
    display_name = person.display_name.strip()
    display_parts = name_parts(display_name)
    if len(display_parts) >= 2:
        return f"{display_parts[0][:1]}.{display_parts[-1]}"

    first = person.first_name.strip()
    last = person.last_name.strip()
    if not first and not last:
        return display_name or person.short_code
    if not last:
        return f"{first[:1]}."
    return f"{first[:1]}.{last}"


def name_parts(display_name: str) -> list[str]:
    return [part for part in display_name.strip().split() if part]
