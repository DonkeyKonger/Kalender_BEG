export type SiteColorOption = {
  name: string;
  value: string;
  label: string;
};

export const SITE_COLOR_OPTIONS: SiteColorOption[] = [
  { name: "Grau", value: "#64748B", label: "bis 5.000 EUR" },
  { name: "Tuerkis", value: "#0891B2", label: "ab 5.000 EUR" },
  { name: "Blau", value: "#2563EB", label: "ab 20.000 EUR" },
  { name: "Dunkelblau", value: "#1E40AF", label: "ab 50.000 EUR" },
  { name: "Gruen", value: "#16A34A", label: "ab 100.000 EUR" },
  { name: "Ocker", value: "#D97706", label: "ab 200.000 EUR" },
  { name: "Orange", value: "#F97316", label: "ab 500.000 EUR" },
  { name: "Rot", value: "#DC2626", label: "ab 1.000.000 EUR" },
  { name: "Violett", value: "#7C3AED", label: "ab 2.000.000 EUR" },
];
