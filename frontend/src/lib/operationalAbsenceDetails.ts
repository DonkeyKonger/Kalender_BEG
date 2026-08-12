type OperationalAbsenceOptionalDetailSource = {
  site: unknown | null;
  text: string | null;
};

export type OperationalAbsenceOptionalDetails = {
  hasSite: boolean;
  noteText: string | null;
};

export function getOperationalAbsenceOptionalDetails(
  absence: OperationalAbsenceOptionalDetailSource,
): OperationalAbsenceOptionalDetails {
  return {
    hasSite: absence.site !== null,
    noteText: absence.text?.trim() || null,
  };
}
