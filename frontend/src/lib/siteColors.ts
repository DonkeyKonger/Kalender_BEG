export type SiteColorOption = {
  name: string;
  value: string;
  label: string;
};

export const SITE_COLOR_OPTIONS: SiteColorOption[] = [
  { name: "Grau", value: "#64748B", label: "bis 5.000 €" },
  { name: "Tuerkis", value: "#0891B2", label: "ab 5.000 €" },
  { name: "Blau", value: "#2563EB", label: "ab 20.000 €" },
  { name: "Dunkelblau", value: "#1E40AF", label: "ab 50.000 €" },
  { name: "Gruen", value: "#16A34A", label: "ab 100.000 €" },
  { name: "Ocker", value: "#D97706", label: "ab 200.000 €" },
  { name: "Orange", value: "#F97316", label: "ab 500.000 €" },
  { name: "Rot", value: "#DC2626", label: "ab 1.000.000 €" },
  { name: "Violett", value: "#7C3AED", label: "ab 2.000.000 €" },
];
