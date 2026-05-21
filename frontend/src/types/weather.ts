export type WeatherSummary = {
  label: string;
  available: boolean;
  temperature: number | null;
  temperature_min: number | null;
  temperature_max: number | null;
  precipitation_probability: number | null;
  precipitation_hint: string;
  wind_speed: number | null;
  summary: string;
  updated_at: string | null;
  is_cached: boolean;
};
