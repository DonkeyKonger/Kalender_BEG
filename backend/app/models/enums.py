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
    PLANNED = "planned"
    COMPLETED = "completed"
    DELETED = "deleted"


class SiteLocationStatus(StrEnum):
    UNCHECKED = "unchecked"
    GEOCODED = "geocoded"
    AMBIGUOUS = "ambiguous"
    FAILED = "failed"


class AssignmentType(StrEnum):
    REGULAR = "regular"
    SUPPORT = "support"
    EMERGENCY = "emergency"
    SELF_PLANNED = "self_planned"


class AbsenceType(StrEnum):
    VACATION = "vacation"
    SICK = "sick"
    SCHOOL = "school"
    FREE = "free"
    OTHER = "other"


class AbsenceStatus(StrEnum):
    ACTIVE = "active"
    CANCELLED = "cancelled"


class MatrixCellMark(StrEnum):
    ORANGE = "orange"
    RED = "red"
    BLUE = "blue"


class GpsSourceType(StrEnum):
    VEHICLE = "vehicle"
    PHONE = "phone"


class VehicleType(StrEnum):
    CAR = "car"
    VAN = "van"
    TRUCK = "truck"
    OTHER = "other"
