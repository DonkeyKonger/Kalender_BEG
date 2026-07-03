export type SiteColorOption = {
  name: string;
  value: string;
  projectValueHint?: string;
};

export const SITE_COLOR_OPTIONS: SiteColorOption[] = [
  { name: "Blau", value: "#2563EB", projectValueHint: "> 20.000 EUR" },
  { name: "Dunkelblau", value: "#1E40AF", projectValueHint: "> 50.000 EUR" },
  { name: "Gruen", value: "#16A34A", projectValueHint: "> 100.000 EUR" },
  { name: "Rot", value: "#DC2626", projectValueHint: "> 1.000.000 EUR" },
  { name: "Orange", value: "#F97316", projectValueHint: "> 500.000 EUR" },
  { name: "Ocker", value: "#D97706", projectValueHint: "> 200.000 EUR" },
  { name: "Tuerkis", value: "#0891B2", projectValueHint: "> 5.000 EUR" },
  { name: "Violett", value: "#7C3AED" },
  { name: "Magenta", value: "#DB2777", projectValueHint: "> 2.000.000 EUR" },
  { name: "Grau", value: "#64748B", projectValueHint: "< 5.000 EUR" },
];

export type SiteProjectValueClass = {
  minValue: number;
  maxValue: number | null;
  label: string;
  color: string;
};

export const SITE_PROJECT_VALUE_CLASSES: SiteProjectValueClass[] = [
  { minValue: 0, maxValue: 5000, label: "< 5.000 EUR", color: "#64748B" },
  { minValue: 5000, maxValue: 20000, label: "> 5.000 EUR", color: "#0891B2" },
  { minValue: 20000, maxValue: 50000, label: "> 20.000 EUR", color: "#2563EB" },
  { minValue: 50000, maxValue: 100000, label: "> 50.000 EUR", color: "#1E40AF" },
  { minValue: 100000, maxValue: 200000, label: "> 100.000 EUR", color: "#16A34A" },
  { minValue: 200000, maxValue: 500000, label: "> 200.000 EUR", color: "#D97706" },
  { minValue: 500000, maxValue: 1000000, label: "> 500.000 EUR", color: "#F97316" },
  { minValue: 1000000, maxValue: 2000000, label: "> 1.000.000 EUR", color: "#DC2626" },
  { minValue: 2000000, maxValue: null, label: "> 2.000.000 EUR", color: "#DB2777" },
];

export function getSiteProjectValueClass(value: number | null | undefined): SiteProjectValueClass | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return SITE_PROJECT_VALUE_CLASSES.find((item) => (
    value >= item.minValue && (item.maxValue === null || value < item.maxValue)
  )) ?? null;
}

export function getSiteColorForProjectValue(value: number | null | undefined): string | null {
  return getSiteProjectValueClass(value)?.color ?? null;
}

export function parseSiteProjectValueInput(value: string): number | null {
  const normalized = value.trim().replace(/\./g, "").replace(",", ".");
  if (!normalized) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function formatSiteProjectValueInput(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "";
  }
  return String(value).replace(".", ",");
}

export function formatSiteProjectValue(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "-";
  }
  return new Intl.NumberFormat("de-DE", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: value % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
}
