from app.models.person import Person


def calendar_short_code(person: Person) -> str:
    first = person.first_name.strip() or person.display_name.strip()
    last = person.last_name.strip() or fallback_last_name(person.display_name)
    if not first and not last:
        return person.short_code
    if not last:
        return f"{first[:1]}."
    return f"{first[:1]}.{last}"


def fallback_last_name(display_name: str) -> str:
    parts = [part for part in display_name.strip().split() if part]
    if len(parts) >= 2:
        return parts[-1]
    return display_name.strip()
