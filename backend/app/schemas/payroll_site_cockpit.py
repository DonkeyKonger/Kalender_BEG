from datetime import date
from typing import Literal

from pydantic import BaseModel, Field


PayrollSiteRiskLevel = Literal["critical", "warning", "none", "missing_data"]
PayrollSiteActionRiskLevel = Literal["critical", "warning", "missing_data"]
PayrollSiteOfferBudgetBasis = Literal["current_active_released_measurement_base"]


class PayrollSiteCockpitTotalsRead(BaseModel):
    measurement_minutes: float = 0
    supplementary_minutes: float = 0
    performance_minutes: float = 0
    realized_actual_minutes: float = 0
    result_minutes: float = 0
    offer_minutes: float | None = None
    actual_minutes: int = Field(ge=0)
    forecast_minutes: int | None = None
    forecast_reason: str
    variance_minutes: float | None = None
    site_count: int = Field(ge=0)
    budget_site_count: int = Field(ge=0)
    forecast_site_count: int = Field(ge=0)


class PayrollSiteCockpitSiteRead(BaseModel):
    site_id: int
    site_number: str | None = None
    site_name: str
    measurement_minutes: float = 0
    supplementary_minutes: float = 0
    performance_minutes: float = 0
    realized_actual_minutes: float = 0
    result_minutes: float = 0
    result_tone: Literal["positive", "negative", "neutral"] = "neutral"
    offer_minutes: float | None = None
    actual_minutes: int = Field(ge=0)
    forecast_minutes: int | None = None
    forecast_reason: str
    variance_minutes: float | None = None
    utilization_percent: float | None = None
    risk_level: PayrollSiteRiskLevel
    risk_reason: str | None = None


class PayrollSiteCockpitActionItemRead(BaseModel):
    rank: int = Field(ge=1, le=3)
    site_id: int
    site_number: str | None = None
    site_name: str
    risk_level: PayrollSiteActionRiskLevel
    reason: str
    variance_minutes: float | None = None
    utilization_percent: float | None = None


class PayrollSiteCockpitRead(BaseModel):
    date_from: date
    date_to: date
    accounting_basis: Literal["measurement_submission_realization"] = "measurement_submission_realization"
    effective_as_of: date = Field(
        description="Stichtag ausschließlich für die kumulierten Ist-Stunden.",
    )
    offer_budget_basis: PayrollSiteOfferBudgetBasis
    offer_budget_as_of: date = Field(
        description=(
            "Abrufstichtag der aktuell aktiven und für Monteure freigegebenen "
            "Angebotsbasis; kein historischer Snapshot."
        ),
    )
    totals: PayrollSiteCockpitTotalsRead
    sites: list[PayrollSiteCockpitSiteRead] = Field(default_factory=list)
    action_items: list[PayrollSiteCockpitActionItemRead] = Field(default_factory=list)


class PayrollSiteCockpitHistoryPointRead(BaseModel):
    date: date
    actual_minutes: int = Field(ge=0)
    forecast_minutes: int | None = None


class PayrollSiteCockpitHistoryRead(BaseModel):
    site_id: int
    site_number: str | None = None
    site_name: str
    date_from: date
    date_to: date
    effective_as_of: date = Field(
        description="Stichtag ausschließlich für die kumulierten Ist-Stunden.",
    )
    offer_budget_basis: PayrollSiteOfferBudgetBasis
    offer_budget_as_of: date = Field(
        description=(
            "Abrufstichtag der aktuell aktiven und für Monteure freigegebenen "
            "Angebotsbasis; kein historischer Snapshot."
        ),
    )
    offer_minutes: float | None = None
    forecast_minutes: int | None = None
    forecast_reason: str
    points: list[PayrollSiteCockpitHistoryPointRead] = Field(default_factory=list)
