export type SiteColorOption = {
  name: string;
  value: string;
  label: string;
};

export const DEFAULT_SITE_COLOR = "#CBD5E1";

export const SITE_COLOR_OPTIONS: SiteColorOption[] = [
  { name: "Hellgrau", value: "#CBD5E1", label: "5.000 €" },
  { name: "Grau", value: "#94A3B8", label: "20.000 €" },
  { name: "Dunkelgrau", value: "#475569", label: "50.000 €" },
  { name: "Hellblau", value: "#60A5FA", label: "100.000 €" },
  { name: "Dunkelblau", value: "#1D4ED8", label: "200.000 €" },
  { name: "Lila", value: "#8B5CF6", label: "500.000 €" },
  { name: "Gruen", value: "#15803D", label: "1.000.000 €" },
  { name: "Orange", value: "#EA580C", label: "2.000.000 €" },
];

export const LEGACY_SITE_COLOR_LABELS: Record<string, string> = {
  "#0891b2": "5.000 €",
  "#64748b": "5.000 €",
  "#2563eb": "20.000 €",
  "#1e40af": "50.000 €",
  "#16a34a": "100.000 €",
  "#d97706": "200.000 €",
  "#f97316": "500.000 €",
  "#dc2626": "1.000.000 €",
  "#7c3aed": "2.000.000 €",
};

export function getSiteColorLabel(value: string | null | undefined): string | null {
  const normalizedValue = value?.toLowerCase();
  if (!normalizedValue) {
    return null;
  }
  return SITE_COLOR_OPTIONS.find((option) => option.value.toLowerCase() === normalizedValue)?.label
    ?? LEGACY_SITE_COLOR_LABELS[normalizedValue]
    ?? null;
}

export function getSiteColorDisplayValue(value: string | null | undefined): string {
  const normalizedValue = value?.toLowerCase();
  if (!normalizedValue) {
    return DEFAULT_SITE_COLOR;
  }
  const currentOption = SITE_COLOR_OPTIONS.find((option) => option.value.toLowerCase() === normalizedValue);
  if (currentOption) {
    return currentOption.value;
  }
  const legacyLabel = LEGACY_SITE_COLOR_LABELS[normalizedValue];
  if (!legacyLabel) {
    return value ?? DEFAULT_SITE_COLOR;
  }
  return SITE_COLOR_OPTIONS.find((option) => option.label === legacyLabel)?.value ?? DEFAULT_SITE_COLOR;
}
