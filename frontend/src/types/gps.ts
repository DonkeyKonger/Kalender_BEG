export type GpsLocationPointCreate = {
  captured_at: string;
  latitude: number;
  longitude: number;
  accuracy_meters?: number | null;
  source?: "mobile";
  device_id?: string | null;
};

export type GpsLocationPointRead = {
  id: number;
  person_id: number;
  captured_at: string;
  latitude: number;
  longitude: number;
  accuracy_meters: number | null;
};

export type GpsRecentLocationPoint = {
  id: number;
  person_id: number;
  person_name: string;
  captured_at: string;
  planned_site_id: number | null;
  planned_site_label: string | null;
  plausibility_status: "matched" | "mismatch" | "not_checkable" | "partial" | "missing";
  distance_to_planned_site_m: number | null;
  geofence_radius_m: number | null;
};
