export type SiteColorOption = {
  name: string;
  value: string;
  label: string;
};

export const SITE_COLOR_OPTIONS: SiteColorOption[] = [
  { name: "Grau", value: "#64748B", label: "5.000 €" },
  { name: "Blau", value: "#2563EB", label: "20.000 €" },
  { name: "Dunkelblau", value: "#1E40AF", label: "50.000 €" },
  { name: "Gruen", value: "#16A34A", label: "100.000 €" },
  { name: "Ocker", value: "#D97706", label: "200.000 €" },
  { name: "Orange", value: "#F97316", label: "500.000 €" },
  { name: "Rot", value: "#DC2626", label: "1.000.000 €" },
  { name: "Violett", value: "#7C3AED", label: "2.000.000 €" },
];

export const LEGACY_SITE_COLOR_LABELS: Record<string, string> = {
  "#0891b2": "5.000 €",
};
