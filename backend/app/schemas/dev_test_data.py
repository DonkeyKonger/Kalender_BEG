from datetime import date

from pydantic import BaseModel, Field


class TimeGpsTestDataStatusResponse(BaseModel):
    enabled: bool
    environment: str
    message: str | None = None


class TimeGpsTestDataGenerateRequest(BaseModel):
    start_date: date | None = None
    end_date: date | None = None
    error_rate: float = Field(default=0.3, ge=0, le=1)
    seed: int | None = None
    clear_previous_test_data: bool = False


class TimeGpsTestDataGenerateResponse(BaseModel):
    batch_id: str
    start_date: str
    end_date: str
    random_seed: int
    people_used: int
    sites_used: int
    assignments_created: int
    work_time_entries_created: int
    gps_points_created: int
    absences_created: int
    created_test_people: int
    created_test_sites: int
    scenarios: dict[str, int]
    expected_open_review_cases: int
    expected_checked_cases: int
    cleared_previous_rows: dict[str, int] = Field(default_factory=dict)


class TimeGpsTestDataClearResponse(BaseModel):
    batch_id: str | None = None
    all_test_data: bool = False
    deleted_counts: dict[str, int]
