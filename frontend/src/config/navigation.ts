import {
  BriefcaseBusiness,
  CalendarDays,
  Download,
  FolderKanban,
  Home,
  Users,
} from "lucide-react";

import type { NavigationItem } from "../types/navigation";

export const navigationItems: NavigationItem[] = [
  {
    label: "Ubersicht",
    path: "/",
    icon: Home,
    roles: ["admin", "project_manager", "office", "monteur"],
  },
  {
    label: "Planmatrix",
    path: "/matrix",
    icon: CalendarDays,
    roles: ["admin", "project_manager", "office"],
  },
  {
    label: "Baustellen",
    path: "/sites",
    icon: BriefcaseBusiness,
    roles: ["admin", "project_manager", "office"],
  },
  {
    label: "Exporte",
    path: "/exports",
    icon: Download,
    roles: ["admin", "project_manager", "office"],
  },
  {
    label: "Personen",
    path: "/persons",
    icon: Users,
    roles: ["admin", "project_manager"],
  },
  {
    label: "Meine Einsaetze",
    path: "/me/assignments",
    icon: FolderKanban,
    roles: ["monteur"],
  },
];
