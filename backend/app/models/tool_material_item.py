from datetime import date

from sqlalchemy import Date, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, TimestampMixin


class ToolMaterialItem(TimestampMixin, Base):
    __tablename__ = "tool_material_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    beg_number: Mapped[str | None] = mapped_column(String(120), unique=True, index=True)
    manufacturer: Mapped[str | None] = mapped_column(String(200), index=True)
    designation: Mapped[str] = mapped_column(String(240), nullable=False, index=True)
    item_type: Mapped[str | None] = mapped_column(String(160), index=True)
    device_number: Mapped[str | None] = mapped_column(String(120), index=True)
    serial_number: Mapped[str | None] = mapped_column(String(160), index=True)
    employee_id: Mapped[int | None] = mapped_column(ForeignKey("persons.id", ondelete="SET NULL"), index=True)
    item_date: Mapped[date | None] = mapped_column(Date)
    delivery_note: Mapped[str | None] = mapped_column(String(160))
    remarks: Mapped[str | None] = mapped_column(Text)
    supplier: Mapped[str | None] = mapped_column(String(200), index=True)
    invoice_number: Mapped[str | None] = mapped_column(String(160), index=True)
    stock: Mapped[int | None] = mapped_column(Integer)

    employee = relationship("Person")
