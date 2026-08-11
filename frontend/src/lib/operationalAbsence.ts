import type { OperationalAbsencePayload } from "./api";

export type OperationalAbsenceDraft = {
  text: string;
  date: string;
  project_manager_id: string;
  start_time: string;
  end_time: string;
  site_id: string;
};

export type OperationalAbsenceDraftResult =
  | { error: null; payload: OperationalAbsencePayload }
  | { error: string; payload: null };

export const EMPTY_OPERATIONAL_ABSENCE_DRAFT: OperationalAbsenceDraft = {
  text: "",
  date: "",
  project_manager_id: "",
  start_time: "",
  end_time: "",
  site_id: "",
};

export const OPERATIONAL_ABSENCES_UPDATED_EVENT = "operational-absences-updated";
const OPERATIONAL_ABSENCES_UPDATED_STORAGE_KEY = "calendar.operational-absences.updated";

export function publishOperationalAbsencesUpdated(): void {
  window.dispatchEvent(new CustomEvent(OPERATIONAL_ABSENCES_UPDATED_EVENT));
  try {
    window.localStorage.setItem(
      OPERATIONAL_ABSENCES_UPDATED_STORAGE_KEY,
      `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
  } catch {
    // Die lokale Aktualisierung funktioniert auch ohne verfügbaren Storage.
  }
}

export function subscribeToOperationalAbsenceUpdates(listener: () => void): () => void {
  const handleLocalUpdate = () => listener();
  const handleStorageUpdate = (event: StorageEvent) => {
    if (event.key === OPERATIONAL_ABSENCES_UPDATED_STORAGE_KEY && event.newValue !== null) {
      listener();
    }
  };
  window.addEventListener(OPERATIONAL_ABSENCES_UPDATED_EVENT, handleLocalUpdate);
  window.addEventListener("storage", handleStorageUpdate);
  return () => {
    window.removeEventListener(OPERATIONAL_ABSENCES_UPDATED_EVENT, handleLocalUpdate);
    window.removeEventListener("storage", handleStorageUpdate);
  };
}

export function operationalAbsencePayloadFromDraft(
  draft: OperationalAbsenceDraft,
): OperationalAbsenceDraftResult {
  if (!draft.date) {
    return invalidDraft("Bitte ein Datum auswählen.");
  }

  const projectManagerId = parsePositiveInteger(draft.project_manager_id);
  if (projectManagerId === null) {
    return invalidDraft("Bitte einen Projektleiter auswählen.");
  }

  const hasStartTime = draft.start_time !== "";
  const hasEndTime = draft.end_time !== "";
  if (hasStartTime !== hasEndTime) {
    return invalidDraft("Bitte Start- und Endzeit vollständig angeben.");
  }
  if (hasStartTime && hasEndTime) {
    const startMinutes = parseTimeMinutes(draft.start_time);
    const endMinutes = parseTimeMinutes(draft.end_time);
    if (startMinutes === null || endMinutes === null) {
      return invalidDraft("Bitte einen gültigen Zeitraum angeben.");
    }
    if (endMinutes <= startMinutes) {
      return invalidDraft("Die Endzeit muss nach der Startzeit liegen.");
    }
  }

  const siteId = draft.site_id === "" ? null : parsePositiveInteger(draft.site_id);
  if (draft.site_id !== "" && siteId === null) {
    return invalidDraft("Bitte eine gültige Baustelle auswählen.");
  }

  return {
    error: null,
    payload: {
      project_manager_id: projectManagerId,
      date: draft.date,
      start_time: hasStartTime ? draft.start_time : null,
      end_time: hasEndTime ? draft.end_time : null,
      site_id: siteId,
      text: draft.text.trim() || null,
    },
  };
}

function invalidDraft(error: string): OperationalAbsenceDraftResult {
  return { error, payload: null };
}

function parsePositiveInteger(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseTimeMinutes(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    return null;
  }
  return hours * 60 + minutes;
}
