export type VehicleDatabaseEmployee = {
  id: number;
  display_name: string;
  short_code: string;
};

export type CtrackVehicleReference = {
  id: number;
  label: string;
  vehicle_registration: string | null;
  fleet_number: string | null;
};

export type VehicleDatabaseItem = {
  id: number;
  license_plate: string;
  manufacturer: string;
  assigned_person_id: number | null;
  assigned_person: VehicleDatabaseEmployee | null;
  ctrack_vehicle_asset_id: number | null;
  ctrack_vehicle: CtrackVehicleReference | null;
  created_at: string;
  updated_at: string;
};

export type VehicleDatabasePayload = {
  license_plate: string;
  manufacturer: string;
  assigned_person_id: number | null;
  ctrack_vehicle_asset_id: number | null;
};

export type CtrackVehicleOption = CtrackVehicleReference & {
  linked_vehicle_id: number | null;
};

export type VehicleDatabaseOptions = {
  employees: VehicleDatabaseEmployee[];
  ctrack_vehicles: CtrackVehicleOption[];
};

export type VehicleDatabaseSortField = "license_plate" | "manufacturer" | "employee" | "ctrack";
export type VehicleDatabaseSortDirection = "asc" | "desc";
