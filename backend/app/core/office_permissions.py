from collections.abc import Iterable

from app.models.enums import UserRole


OFFICE_PAGE_OVERVIEW = "overview"
OFFICE_PAGE_CALENDAR = "calendar"
OFFICE_PAGE_ABSENCES = "absences"
OFFICE_PAGE_SITES = "sites"
OFFICE_PAGE_MAP = "map"
OFFICE_PAGE_PAYROLL = "payroll"
OFFICE_PAGE_CUSTOMERS = "customers"
OFFICE_PAGE_EMPLOYEES = "employees"
OFFICE_PAGE_EXPORT = "export"

OFFICE_PAGE_PERMISSIONS = (
    OFFICE_PAGE_OVERVIEW,
    OFFICE_PAGE_CALENDAR,
    OFFICE_PAGE_ABSENCES,
    OFFICE_PAGE_SITES,
    OFFICE_PAGE_MAP,
    OFFICE_PAGE_PAYROLL,
    OFFICE_PAGE_CUSTOMERS,
    OFFICE_PAGE_EMPLOYEES,
    OFFICE_PAGE_EXPORT,
)
OFFICE_PAGE_PERMISSION_SET = set(OFFICE_PAGE_PERMISSIONS)
DEFAULT_EXISTING_OFFICE_PAGE_PERMISSIONS = [
    OFFICE_PAGE_OVERVIEW,
    OFFICE_PAGE_CALENDAR,
    OFFICE_PAGE_ABSENCES,
    OFFICE_PAGE_SITES,
    OFFICE_PAGE_MAP,
    OFFICE_PAGE_PAYROLL,
    OFFICE_PAGE_EXPORT,
]


def normalize_office_page_permissions(value: Iterable[str] | None) -> list[str]:
    if value is None:
        return []
    requested = list(value)
    invalid = [permission for permission in requested if permission not in OFFICE_PAGE_PERMISSION_SET]
    if invalid:
        raise ValueError("Ungueltige Büro-Sichtrechte.")
    requested_set = set(requested)
    return [permission for permission in OFFICE_PAGE_PERMISSIONS if permission in requested_set]


def office_user_can_access(user, *page_keys: str) -> bool:
    if user.role != UserRole.OFFICE:
        return True
    permissions = set(getattr(user, "office_page_permissions", None) or [])
    return any(page_key in permissions for page_key in page_keys)
