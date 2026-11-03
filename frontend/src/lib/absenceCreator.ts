import type { Absence } from "../types/absence";

export function absenceCreator(absence: Pick<Absence, "created_by_name" | "created_by_short_code">) {
  const name = absence.created_by_name?.trim();
  const code = absence.created_by_short_code?.trim();
  const creator = name && code && name !== code ? `${name} (${code})` : name || code;
  return {
    code: code || "–",
    description: creator ? `Eingetragen von ${creator}` : "Ersteller nicht hinterlegt",
  };
}
