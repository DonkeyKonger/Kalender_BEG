from datetime import date
from typing import Literal

from pydantic import BaseModel


class DashboardBillingItemRead(BaseModel):
    id: int
    kind: Literal["measurement", "extra_work"]
    title: str
    status: str
    status_label: str
    date: date | None


class DashboardBillingSiteRead(BaseModel):
    site_id: int
    site_number: str | None
    site_name: str
    project_manager_name: str | None
    items: list[DashboardBillingItemRead]


class DashboardBillingRead(BaseModel):
    open_count: int
    sites: list[DashboardBillingSiteRead]
