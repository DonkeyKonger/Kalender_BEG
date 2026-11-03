import type { Absence } from "../types/absence";

export function absenceCreator(absence: Pick<Absence, "created_by_name">) {
  const name = absence.created_by_name?.trim();
  return {
    label: name || "–",
    description: name ? `Eingetragen von ${name}` : "Ersteller nicht hinterlegt",
  };
}
