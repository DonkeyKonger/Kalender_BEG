import type { LucideIcon } from "lucide-react";

import type { UserRole } from "./auth";

export type NavigationItem = {
  label: string;
  path: string;
  icon: LucideIcon;
  roles: UserRole[];
};
