from fastapi import HTTPException, status
from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, aliased, joinedload

from app.models.enums import PersonEmploymentStatus, PersonType, UserRole, VehicleType
from app.models.person import Person
from app.models.user import User
from app.models.vehicle import Vehicle, VehicleAsset
from app.schemas.vehicle_database import (
    CtrackVehicleOptionRead,
    CtrackVehicleRead,
    VehicleCreate,
    VehicleEmployeeOptionRead,
    VehicleListQuery,
    VehicleOptionsRead,
    VehicleRead,
    VehicleUpdate,
)


class VehicleDatabaseService:
    def __init__(self, db: Session) -> None:
        self.db = db

    def list_vehicles(self, query: VehicleListQuery) -> list[VehicleRead]:
        employee = aliased(Person)
        asset = aliased(VehicleAsset)
        statement = (
            select(Vehicle)
            .outerjoin(employee, Vehicle.assigned_person_id == employee.id)
            .outerjoin(asset, Vehicle.ctrack_vehicle_asset_id == asset.id)
            .options(
                joinedload(Vehicle.assigned_person),
                joinedload(Vehicle.ctrack_vehicle_asset),
            )
        )
        search = (query.search or "").strip()
        if search:
            needle = f"%{search}%"
            statement = statement.where(
                or_(
                    Vehicle.license_plate.ilike(needle),
                    Vehicle.manufacturer.ilike(needle),
                    employee.display_name.ilike(needle),
                    employee.short_code.ilike(needle),
                    asset.label.ilike(needle),
                    asset.vehicle_registration.ilike(needle),
                    asset.fleet_number.ilike(needle),
                )
            )

        columns = {
            "license_plate": func.lower(Vehicle.license_plate),
            "manufacturer": func.lower(Vehicle.manufacturer),
            "employee": func.lower(employee.display_name),
            "ctrack": func.lower(
                func.coalesce(asset.label, asset.vehicle_registration, asset.fleet_number)
            ),
        }
        sort_column = columns[query.sort_by]
        direction = sort_column.desc() if query.sort_direction == "desc" else sort_column.asc()
        statement = statement.order_by(sort_column.is_(None), direction, Vehicle.id)
        return [self._read(vehicle) for vehicle in self.db.scalars(statement).unique()]

    def get_vehicle(self, vehicle_id: int) -> VehicleRead:
        return self._read(self._get(vehicle_id))

    def options(self) -> VehicleOptionsRead:
        employees = self.db.scalars(
            select(Person)
            .where(
                Person.person_type == PersonType.INTERNAL,
                Person.is_active.is_(True),
                Person.employment_status == PersonEmploymentStatus.ACTIVE.value,
                Person.deleted_at.is_(None),
                ~Person.users.any(
                    User.role.in_([UserRole.ADMIN, UserRole.OFFICE, UserRole.PROJECT_MANAGER])
                ),
            )
            .order_by(Person.last_name, Person.first_name, Person.id)
        ).all()
        linked_rows = dict(
            self.db.execute(
                select(Vehicle.ctrack_vehicle_asset_id, Vehicle.id).where(
                    Vehicle.ctrack_vehicle_asset_id.is_not(None)
                )
            ).all()
        )
        assets = self.db.scalars(
            select(VehicleAsset)
            .where(VehicleAsset.source == "ctrack")
            .order_by(VehicleAsset.label, VehicleAsset.vehicle_registration, VehicleAsset.id)
        ).all()
        return VehicleOptionsRead(
            employees=[VehicleEmployeeOptionRead.model_validate(person) for person in employees],
            ctrack_vehicles=[
                CtrackVehicleOptionRead(
                    **self._ctrack_read(asset).model_dump(),
                    linked_vehicle_id=linked_rows.get(asset.id),
                )
                for asset in assets
            ],
        )

    def create_vehicle(self, payload: VehicleCreate) -> VehicleRead:
        self._validate_relations(payload.assigned_person_id, payload.ctrack_vehicle_asset_id)
        self._ensure_unique_license(payload.license_plate)
        self._ensure_unique_ctrack(payload.ctrack_vehicle_asset_id)
        vehicle = Vehicle(
            license_plate=payload.license_plate,
            manufacturer=payload.manufacturer,
            name=payload.manufacturer,
            vehicle_type=VehicleType.VAN,
            assigned_person_id=payload.assigned_person_id,
            ctrack_vehicle_asset_id=payload.ctrack_vehicle_asset_id,
        )
        self.db.add(vehicle)
        self._commit(vehicle)
        return self.get_vehicle(vehicle.id)

    def update_vehicle(self, vehicle_id: int, payload: VehicleUpdate) -> VehicleRead:
        vehicle = self._get(vehicle_id)
        values = payload.model_dump(exclude_unset=True)
        assigned_person_id = values.get("assigned_person_id", vehicle.assigned_person_id)
        asset_id = values.get("ctrack_vehicle_asset_id", vehicle.ctrack_vehicle_asset_id)
        self._validate_relations(
            assigned_person_id,
            asset_id,
            existing_person_id=vehicle.assigned_person_id,
            existing_asset_id=vehicle.ctrack_vehicle_asset_id,
        )
        if "license_plate" in values:
            self._ensure_unique_license(values["license_plate"], exclude_vehicle_id=vehicle.id)
        if "ctrack_vehicle_asset_id" in values:
            self._ensure_unique_ctrack(asset_id, exclude_vehicle_id=vehicle.id)
        for key, value in values.items():
            setattr(vehicle, key, value)
        if "manufacturer" in values:
            vehicle.name = values["manufacturer"]
        self._commit(vehicle)
        return self.get_vehicle(vehicle.id)

    def delete_vehicle(self, vehicle_id: int) -> None:
        vehicle = self._get(vehicle_id)
        self.db.delete(vehicle)
        self.db.commit()

    def _get(self, vehicle_id: int) -> Vehicle:
        vehicle = self.db.scalar(
            select(Vehicle)
            .where(Vehicle.id == vehicle_id)
            .options(
                joinedload(Vehicle.assigned_person),
                joinedload(Vehicle.ctrack_vehicle_asset),
            )
        )
        if vehicle is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Fahrzeug nicht gefunden.")
        return vehicle

    def _validate_relations(
        self,
        person_id: int | None,
        asset_id: int | None,
        *,
        existing_person_id: int | None = None,
        existing_asset_id: int | None = None,
    ) -> None:
        if person_id is not None:
            person = self.db.get(Person, person_id)
            has_non_worker_role = self.db.scalar(
                select(User.id).where(
                    User.person_id == person_id,
                    User.role.in_([UserRole.ADMIN, UserRole.OFFICE, UserRole.PROJECT_MANAGER]),
                )
            )
            if person_id != existing_person_id and (
                person is None
                or person.deleted_at is not None
                or not person.is_active
                or person.person_type != PersonType.INTERNAL
                or person.employment_status != PersonEmploymentStatus.ACTIVE.value
                or has_non_worker_role is not None
            ):
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    "Der Monteur ist nicht aktiv oder nicht zuordenbar.",
                )
        if asset_id is not None:
            asset = self.db.get(VehicleAsset, asset_id)
            if (
                asset is None
                or asset.source != "ctrack"
                or (asset_id != existing_asset_id and not asset.is_active)
            ):
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST, "Das C-Track-Fahrzeug ist nicht verfügbar."
                )

    def _ensure_unique_license(
        self, license_plate: str, exclude_vehicle_id: int | None = None
    ) -> None:
        statement = select(Vehicle.id).where(
            func.lower(Vehicle.license_plate) == license_plate.lower()
        )
        if exclude_vehicle_id is not None:
            statement = statement.where(Vehicle.id != exclude_vehicle_id)
        if self.db.scalar(statement) is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Dieses Kennzeichen ist bereits vorhanden."
            )

    def _ensure_unique_ctrack(
        self, asset_id: int | None, exclude_vehicle_id: int | None = None
    ) -> None:
        if asset_id is None:
            return
        statement = select(Vehicle.id).where(Vehicle.ctrack_vehicle_asset_id == asset_id)
        if exclude_vehicle_id is not None:
            statement = statement.where(Vehicle.id != exclude_vehicle_id)
        if self.db.scalar(statement) is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT, "Dieses C-Track-Fahrzeug ist bereits verknüpft."
            )

    def _commit(self, vehicle: Vehicle) -> None:
        try:
            self.db.commit()
        except IntegrityError as error:
            self.db.rollback()
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "Kennzeichen oder C-Track-Verknüpfung ist bereits vergeben.",
            ) from error
        self.db.refresh(vehicle)

    def _read(self, vehicle: Vehicle) -> VehicleRead:
        return VehicleRead(
            id=vehicle.id,
            license_plate=vehicle.license_plate,
            manufacturer=vehicle.manufacturer,
            assigned_person_id=vehicle.assigned_person_id,
            assigned_person=vehicle.assigned_person,
            ctrack_vehicle_asset_id=vehicle.ctrack_vehicle_asset_id,
            ctrack_vehicle=(
                self._ctrack_read(vehicle.ctrack_vehicle_asset)
                if vehicle.ctrack_vehicle_asset is not None
                else None
            ),
            created_at=vehicle.created_at,
            updated_at=vehicle.updated_at,
        )

    @staticmethod
    def _ctrack_read(asset: VehicleAsset) -> CtrackVehicleRead:
        label = (
            asset.label
            or asset.vehicle_registration
            or asset.fleet_number
            or f"Fahrzeug {asset.external_id}"
        )
        return CtrackVehicleRead(
            id=asset.id,
            label=label,
            vehicle_registration=asset.vehicle_registration,
            fleet_number=asset.fleet_number,
        )
