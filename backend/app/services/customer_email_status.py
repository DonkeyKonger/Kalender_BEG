from datetime import datetime

CustomerEmailStatus = tuple[datetime, bool | None, list[str]]


def audit_email_recipients(payload: dict) -> list[str]:
    """Use the recorded delivery recipients, never today's project contacts."""
    values = payload.get("recipients")
    if not isinstance(values, list):
        return []
    recipients: list[str] = []
    seen: set[str] = set()
    for value in values:
        if not isinstance(value, str):
            continue
        email = value.strip()
        if email and email.casefold() not in seen:
            recipients.append(email)
            seen.add(email.casefold())
    return recipients
