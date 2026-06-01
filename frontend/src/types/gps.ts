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
