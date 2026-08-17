from enum import StrEnum


def enum_values(enum_cls: type[StrEnum]) -> list[str]:
    return [item.value for item in enum_cls]


class UserRole(StrEnum):
    ADMIN = "admin"
    PROJECT_MANAGER = "project_manager"
    OFFICE = "office"
    MONTEUR = "monteur"


class OvernightStatus(StrEnum):
    NONE = "none"
    SELF_PAID = "self_paid"
    BEG_PAID = "beg_paid"


class MeasurementBatchOrigin(StrEnum):
    MONTEUR = "MONTEUR"
    OFFICE = "OFFICE"
    LEGACY = "LEGACY"


class MeasurementPositionMode(StrEnum):
    OFFER_BASED = "OFFER_BASED"
    BLANK = "BLANK"


class PersonType(StrEnum):
    INTERNAL = "internal"
    EXTERNAL = "external"
    EXTERNAL_TEMP = "external_temp"


class PersonEmploymentStatus(StrEnum):
    ACTIVE = "active"
    PAUSED = "paused"
    DEPARTED = "departed"


class ToolMaterialStatus(StrEnum):
    ISSUED = "issued"
    WAREHOUSE = "warehouse"
    WRITTEN_OFF = "written_off"


class ToolMaterialCategory(StrEnum):
    DRILLING_SCREWING = "drilling_screwing"
    GRINDING_CUTTING = "grinding_cutting"
    SAWING = "sawing"
    VACUUMING = "vacuuming"
    MEASURING = "measuring"
    BATTERIES_CHARGING = "batteries_charging"
    HAND_TOOLS = "hand_tools"
    LADDERS_WORK_EQUIPMENT = "ladders_work_equipment"
    TESTING_EQUIPMENT = "testing_equipment"
    VEHICLE_ACCESSORIES = "vehicle_accessories"
    MATERIAL = "material"
    OTHER = "other"


class ToolIssueReason(StrEnum):
    DEFECTIVE = "DEFECTIVE"
    STOLEN = "STOLEN"


class ToolIssueStatus(StrEnum):
    OPEN = "open"


TOOL_MATERIAL_STATUS_PRIORITY = {
    ToolMaterialStatus.WAREHOUSE: 1,
    ToolMaterialStatus.ISSUED: 2,
    ToolMaterialStatus.WRITTEN_OFF: 3,
}


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
