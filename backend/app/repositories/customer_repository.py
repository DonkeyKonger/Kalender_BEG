from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.customer import Customer


class CustomerRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get(self, customer_id: int) -> Customer | None:
        return self.db.scalar(
            select(Customer)
            .options(selectinload(Customer.contacts))
            .where(Customer.id == customer_id, Customer.deleted_at.is_(None))
        )

    def get_including_deleted(self, customer_id: int) -> Customer | None:
        return self.db.scalar(
            select(Customer)
            .options(selectinload(Customer.contacts))
            .where(Customer.id == customer_id)
        )

    def list(self, is_active: bool | None = None) -> list[Customer]:
        statement = (
            select(Customer)
            .options(selectinload(Customer.contacts))
            .where(Customer.deleted_at.is_(None))
            .order_by(Customer.company_name)
        )
        if is_active is not None:
            statement = statement.where(Customer.is_active == is_active)
        return list(self.db.scalars(statement))

    def add(self, customer: Customer) -> Customer:
        self.db.add(customer)
        self.db.flush()
        return customer
