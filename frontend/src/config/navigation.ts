import {
  BriefcaseBusiness,
  Building2,
  CalendarDays,
  CalendarX,
  Clock3,
  Download,
  FolderKanban,
  Home,
  MapPinned,
  ShieldCheck,
  Users,
} from "lucide-react";

import type { NavigationItem } from "../types/navigation";

export const navigationItems: NavigationItem[] = [
  {
    label: "Übersicht",
    path: "/",
    icon: Home,
    roles: ["admin", "project_manager", "office", "monteur"],
  },
  {
    label: "Baustellenkalender",
    path: "/matrix",
    icon: CalendarDays,
    roles: ["admin", "project_manager", "office"],
  },
  {
    label: "Abwesenheiten",
    path: "/absences",
    icon: CalendarX,
    roles: ["admin", "project_manager", "office"],
  },
  {
    label: "Lohnprüfung",
    path: "/time-entries",
    icon: Clock3,
    roles: ["admin", "project_manager", "office"],
  },
  {
    label: "Baustellen",
    path: "/sites",
    icon: BriefcaseBusiness,
    roles: ["admin", "project_manager", "office"],
  },
  {
    label: "Kartenübersicht",
    path: "/site-map",
    icon: MapPinned,
    roles: ["admin", "project_manager", "office"],
  },
  {
    label: "Kunden",
    path: "/customers",
    icon: Building2,
    roles: ["admin", "project_manager"],
  },
  {
    label: "Personen",
    path: "/persons",
    icon: Users,
    roles: ["admin", "project_manager"],
  },
  {
    label: "Export",
    path: "/exports",
    icon: Download,
    roles: ["admin", "project_manager", "office"],
  },
  {
    label: "Benutzer (admin)",
    path: "/users",
    icon: ShieldCheck,
    roles: ["admin"],
  },
  {
    label: "Meine Einsaetze",
    path: "/me/assignments",
    icon: FolderKanban,
    roles: ["monteur"],
  },
];
