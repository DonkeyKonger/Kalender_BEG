export type MeasurementManualStatus = "draft" | "submitted" | "reviewed" | "billed";
export type ExtraWorkManualStatus = "submitted" | "billed";

export type ProjectRecordStatusOption<T extends string> = {
  value: T;
  label: string;
};

const completedStatuses = new Set([
  "billed",
  "approved",
  "closed",
  "completed",
  "finalized",
  "abgeschlossen",
]);

const measurementTargets: Array<ProjectRecordStatusOption<MeasurementManualStatus> & { rank: number }> = [
  { value: "submitted", label: "Eingereicht", rank: 1 },
  { value: "reviewed", label: "Geprüft", rank: 2 },
  { value: "billed", label: "Abgeschlossen", rank: 4 },
];

const measurementDraftResetOption: ProjectRecordStatusOption<MeasurementManualStatus> = {
  value: "draft",
  label: "Als Entwurf zurücksetzen",
};

const extraWorkTargets: Array<ProjectRecordStatusOption<ExtraWorkManualStatus> & { rank: number }> = [
  { value: "submitted", label: "Eingereicht", rank: 1 },
  { value: "billed", label: "Abgeschlossen", rank: 3 },
];

export function measurementStatusPromotionOptions(
  status: string,
  customerSignedAt: string | null,
): ProjectRecordStatusOption<MeasurementManualStatus>[] {
  const normalizedStatus = status.trim().toLowerCase();
  const statusRank = measurementStatusRank(normalizedStatus);
  const rank = statusRank === null
    ? (customerSignedAt ? 3 : null)
    : Math.max(statusRank, customerSignedAt ? 3 : statusRank);
  if (rank === null) return [];
  const forwardOptions = measurementTargets
    .filter((target) => target.rank > rank)
    .map(({ value, label }) => ({ value, label }));
  return normalizedStatus === "draft"
    ? forwardOptions
    : [...forwardOptions, measurementDraftResetOption];
}

export function extraWorkStatusPromotionOptions(
  status: string,
  customerSignedAt: string | null,
): ProjectRecordStatusOption<ExtraWorkManualStatus>[] {
  const statusRank = extraWorkStatusRank(status);
  const rank = statusRank === null
    ? (customerSignedAt ? 2 : null)
    : Math.max(statusRank, customerSignedAt ? 2 : statusRank);
  return rank === null
    ? []
    : extraWorkTargets.filter((target) => target.rank > rank).map(({ value, label }) => ({ value, label }));
}

function measurementStatusRank(value: string): number | null {
  const status = value.trim().toLowerCase();
  if (status === "draft") return 0;
  if (["submitted", "in_review", "rejected"].includes(status)) return 1;
  if (["reviewed", "checked"].includes(status)) return 2;
  if (["customer_signed", "signed"].includes(status)) return 3;
  if (completedStatuses.has(status)) return 4;
  return null;
}

function extraWorkStatusRank(value: string): number | null {
  const status = value.trim().toLowerCase();
  if (status === "draft") return 0;
  if (["submitted", "reviewed"].includes(status)) return 1;
  if (["signed", "customer_signed"].includes(status)) return 2;
  if (completedStatuses.has(status)) return 3;
  return null;
}
