from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api.dependencies import require_roles
from app.core.database import get_db
from app.models.enums import UserRole
from app.schemas.customer import CustomerCreate, CustomerRead, CustomerRemoveResponse, CustomerUpdate
from app.services.customer_service import CustomerService

router = APIRouter(prefix="/customers", tags=["customers"])

CAN_READ = require_roles(UserRole.ADMIN, UserRole.PROJECT_MANAGER)
CAN_WRITE = require_roles(UserRole.ADMIN, UserRole.PROJECT_MANAGER)
CAN_ADMIN = require_roles(UserRole.ADMIN)


@router.get("", response_model=list[CustomerRead])
def list_customers(
    is_active: bool | None = None,
    _user=Depends(CAN_READ),
    db: Session = Depends(get_db),
) -> list[CustomerRead]:
    service = CustomerService(db)
    return [service.read_customer(customer) for customer in service.list_customers(is_active=is_active)]


@router.post("", response_model=CustomerRead, status_code=201)
def create_customer(
    payload: CustomerCreate,
    current_user=Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> CustomerRead:
    service = CustomerService(db)
    customer = service.create_customer(payload, current_user.id)
    return service.read_customer(customer)


@router.patch("/{customer_id}", response_model=CustomerRead)
def update_customer(
    customer_id: int,
    payload: CustomerUpdate,
    current_user=Depends(CAN_WRITE),
    db: Session = Depends(get_db),
) -> CustomerRead:
    service = CustomerService(db)
    customer = service.update_customer(customer_id, payload, current_user.id)
    return service.read_customer(customer)


@router.post("/{customer_id}/remove", response_model=CustomerRemoveResponse)
def remove_customer(
    customer_id: int,
    current_user=Depends(CAN_ADMIN),
    db: Session = Depends(get_db),
) -> CustomerRemoveResponse:
    service = CustomerService(db)
    customer = service.remove_customer(customer_id, current_user.id)
    return CustomerRemoveResponse(action="deactivated", customer=service.read_customer(customer))
