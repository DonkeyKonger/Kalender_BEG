import type { ReactNode } from "react";

export type StatusBadgeTone =
  | "active"
  | "inactive"
  | "paused"
  | "closed"
  | "archived"
  | "warning"
  | "danger"
  | "neutral"
  | "role"
  | "absence";

export type StatusBadgeProps = {
  children: ReactNode;
  tone?: StatusBadgeTone;
  className?: string;
};

export function StatusBadge({ children, tone = "neutral", className }: StatusBadgeProps) {
  const classes = ["status-badge", `status-badge-${tone}`, className].filter(Boolean).join(" ");

  return <span className={classes}>{children}</span>;
}
