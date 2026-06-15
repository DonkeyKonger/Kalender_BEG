import type { ReactNode } from "react";

import type { UserRole } from "../types/auth";
import type { AbsenceType, SiteStatus } from "../types/matrix";

export type StatusBadgeTone =
  | "active"
  | "inactive"
  | "paused"
  | "planned"
  | "completed"
  | "deleted"
  | "warning"
  | "danger"
  | "neutral"
  | "role"
  | "absence"
  | "vacation"
  | "sick"
  | "school"
  | "free"
  | "other";

export type StatusBadgeProps = {
  children: ReactNode;
  tone?: StatusBadgeTone;
  className?: string;
};

export const siteStatusLabels: Record<SiteStatus, string> = {
  active: "Aktiv",
  paused: "Pause",
  planned: "Gepl.",
  completed: "Abges.",
  deleted: "Gelöscht",
};

export const roleLabels: Record<UserRole, string> = {
  admin: "Admin",
  project_manager: "Projektleiter",
  office: "Büro",
  monteur: "Monteur",
};

export const absenceTypeLabels: Record<AbsenceType, string> = {
  vacation: "Urlaub",
  sick: "Krank",
  school: "Schule",
  free: "Frei",
  other: "Sonstiges",
};

export function StatusBadge({ children, tone = "neutral", className }: StatusBadgeProps) {
  const classes = ["status-badge", `status-badge-${tone}`, className].filter(Boolean).join(" ");

  return <span className={classes}>{children}</span>;
}

export function SiteStatusBadge({ status }: { status: SiteStatus }) {
  return <StatusBadge tone={siteStatusTone(status)}>{siteStatusLabels[status]}</StatusBadge>;
}

export function RoleBadge({ role }: { role: UserRole }) {
  return <StatusBadge tone="role">{roleLabels[role]}</StatusBadge>;
}

export function AbsenceTypeBadge({ type }: { type: AbsenceType }) {
  return <StatusBadge tone={type}>{absenceTypeLabels[type]}</StatusBadge>;
}

function siteStatusTone(status: SiteStatus): StatusBadgeTone {
  if (status === "active") {
    return "active";
  }
  if (status === "paused") {
    return "paused";
  }
  if (status === "planned") {
    return "planned";
  }
  if (status === "deleted") {
    return "deleted";
  }
  return "completed";
}
