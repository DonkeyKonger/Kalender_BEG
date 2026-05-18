from enum import StrEnum


def enum_values(enum_cls: type[StrEnum]) -> list[str]:
    return [item.value for item in enum_cls]


class UserRole(StrEnum):
    ADMIN = "admin"
    PROJECT_MANAGER = "project_manager"
    OFFICE = "office"
    MONTEUR = "monteur"


class PersonType(StrEnum):
    INTERNAL = "internal"
    EXTERNAL = "external"
    EXTERNAL_TEMP = "external_temp"


class SiteStatus(StrEnum):
    ACTIVE = "active"
    PAUSED = "paused"
    CLOSED = "closed"
    ARCHIVED = "archived"


class AssignmentType(StrEnum):
    REGULAR = "regular"
    SUPPORT = "support"
    EMERGENCY = "emergency"


class AbsenceType(StrEnum):
    VACATION = "vacation"
    SICK = "sick"
    SCHOOL = "school"
    FREE = "free"
    OTHER = "other"


class AbsenceStatus(StrEnum):
    ACTIVE = "active"
    CANCELLED = "cancelled"


class VehicleType(StrEnum):
    CAR = "car"
    VAN = "van"
    TRUCK = "truck"
    OTHER = "other"
