from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.dependencies import require_admin_or_office_page, require_business_page
from app.core.database import get_db
from app.models.user import User
from app.schemas.payroll_month import (
    PayrollMonthAuditRead,
    PayrollMonthLockRequest,
    PayrollMonthReopenRequest,
    PayrollMonthStatusRead,
)
from app.services.payroll_month_close_service import PayrollMonthCloseService


router = APIRouter(prefix="/payroll-months", tags=["payroll-months"])
CAN_READ = require_business_page("payroll")
CAN_MANAGE = require_admin_or_office_page("payroll")


@router.get("/{year}/{month}", response_model=PayrollMonthStatusRead)
def get_payroll_month_status(
    year: int,
    month: int,
    current_user: User = Depends(CAN_READ),
    db: Session = Depends(get_db),
) -> PayrollMonthStatusRead:
    return PayrollMonthCloseService(db).get_status(
        year=year,
        month=month,
        current_user=current_user,
    )


@router.post("/{year}/{month}/lock", response_model=PayrollMonthStatusRead)
def lock_payroll_month(
    year: int,
    month: int,
    payload: PayrollMonthLockRequest,
    current_user: User = Depends(CAN_MANAGE),
    db: Session = Depends(get_db),
) -> PayrollMonthStatusRead:
    return PayrollMonthCloseService(db).lock_month(
        year=year,
        month=month,
        confirmed=payload.confirmed,
        current_user=current_user,
    )


@router.post("/{year}/{month}/reopen", response_model=PayrollMonthStatusRead)
def reopen_payroll_month(
    year: int,
    month: int,
    payload: PayrollMonthReopenRequest,
    current_user: User = Depends(CAN_MANAGE),
    db: Session = Depends(get_db),
) -> PayrollMonthStatusRead:
    return PayrollMonthCloseService(db).reopen_month(
        year=year,
        month=month,
        reason=payload.reason,
        current_user=current_user,
    )


@router.get("/{year}/{month}/audits", response_model=list[PayrollMonthAuditRead])
def list_payroll_month_audits(
    year: int,
    month: int,
    _current_user: User = Depends(CAN_READ),
    db: Session = Depends(get_db),
) -> list[PayrollMonthAuditRead]:
    return [
        PayrollMonthAuditRead.model_validate(item)
        for item in PayrollMonthCloseService(db).list_audits(year=year, month=month)
    ]
