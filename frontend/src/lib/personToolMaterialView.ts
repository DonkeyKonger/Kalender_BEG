import type { PersonToolMaterialItem } from "../types/person";

export const PERSON_TOOL_MATERIAL_EMPTY_TEXT = (
  "Diesem Mitarbeiter sind aktuell keine Werkzeuge oder Materialien zugeordnet."
);

export type PersonToolMaterialViewState = "loading" | "error" | "empty" | "ready";

export function getPersonToolMaterialViewState({
  isLoading,
  error,
  items,
}: {
  isLoading: boolean;
  error: string | null;
  items: PersonToolMaterialItem[];
}): PersonToolMaterialViewState {
  if (isLoading) {
    return "loading";
  }
  if (error) {
    return "error";
  }
  return items.length ? "ready" : "empty";
}

export function formatPersonToolMaterialDate(value: string | null): string {
  if (!value) {
    return "–";
  }
  return new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00`));
}
