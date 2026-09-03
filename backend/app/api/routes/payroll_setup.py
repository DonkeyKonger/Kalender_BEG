from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from app.api.dependencies import require_admin_or_office_page
from app.core.database import get_db
from app.models.payroll_daily_ledger import PAYROLL_LEDGER_CUTOVER_DATE
from app.models.user import User
from app.schemas.payroll_setup import (
    PayrollOpeningBalanceUpsert,
    PayrollSetupRead,
    PayrollWeeklyPlanUpsert,
)
from app.services.payroll_daily_ledger_service import (
    PayrollDailyLedgerService,
    PayrollSetupValidationError,
)


router = APIRouter(prefix="/payroll-setup", tags=["payroll-setup"])
CAN_MANAGE = require_admin_or_office_page("payroll")


@router.get("", response_model=PayrollSetupRead)
def payroll_setup_status(
    effective_date: date = Query(default=PAYROLL_LEDGER_CUTOVER_DATE),
    _current_user: User = Depends(CAN_MANAGE),
    db: Session = Depends(get_db),
) -> PayrollSetupRead:
    return PayrollDailyLedgerService(db).setup_status(effective_date=effective_date)


@router.put(
    "/workers/{person_id}/weekly-plan",
    response_model=PayrollSetupRead,
)
def upsert_payroll_weekly_plan(
    person_id: int,
    payload: PayrollWeeklyPlanUpsert,
    current_user: User = Depends(CAN_MANAGE),
    db: Session = Depends(get_db),
) -> PayrollSetupRead:
    service = PayrollDailyLedgerService(db)
    try:
        service.upsert_weekly_schedule(
            person_id=person_id,
            payload=payload,
            current_user=current_user,
        )
        db.commit()
        return service.setup_status(effective_date=PAYROLL_LEDGER_CUTOVER_DATE)
    except PayrollSetupValidationError as error:
        db.rollback()
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(error)) from error


@router.put(
    "/workers/{person_id}/opening-balance",
    response_model=PayrollSetupRead,
)
def upsert_payroll_opening_balance(
    person_id: int,
    payload: PayrollOpeningBalanceUpsert,
    current_user: User = Depends(CAN_MANAGE),
    db: Session = Depends(get_db),
) -> PayrollSetupRead:
    service = PayrollDailyLedgerService(db)
    try:
        service.upsert_opening_balance(
            person_id=person_id,
            payload=payload,
            current_user=current_user,
        )
        db.commit()
        return service.setup_status(effective_date=PAYROLL_LEDGER_CUTOVER_DATE)
    except PayrollSetupValidationError as error:
        db.rollback()
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(error)) from error
