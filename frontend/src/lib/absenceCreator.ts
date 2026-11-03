import type { Absence } from "../types/absence";

export function absenceCreator(absence: Pick<Absence, "created_by_name">) {
  const name = absence.created_by_name?.trim();
  return {
    label: name ? creatorInitials(name) : "–",
    description: name ? `Eingetragen von ${name}` : "Ersteller nicht hinterlegt",
  };
}

function creatorInitials(name: string): string {
  const parts = name.split(/[\s-]+/).filter(Boolean);
  if (parts.length > 1) {
    return parts.map((part) => Array.from(part)[0]).join("").toUpperCase();
  }
  const letters = Array.from(name);
  return letters.length > 2 ? letters[0].toUpperCase() : name;
}
