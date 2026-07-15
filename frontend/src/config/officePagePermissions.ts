import type { OfficePagePermission } from "../types/auth";

export type OfficePagePermissionOption = {
  key: OfficePagePermission;
  label: string;
};

export const officePagePermissionOptions: OfficePagePermissionOption[] = [
  { key: "overview", label: "Übersicht" },
  { key: "calendar", label: "Baustellenkalender" },
  { key: "absences", label: "Abwesenheiten" },
  { key: "sites", label: "Baustellen" },
  { key: "map", label: "Kartenübersicht" },
  { key: "payroll", label: "Lohnprüfung" },
  { key: "customers", label: "Kunden" },
  { key: "employees", label: "Mitarbeiter" },
  { key: "export", label: "Export" },
  { key: "miscellaneous", label: "Sonstige" },
];

export const allOfficePagePermissions = officePagePermissionOptions.map((item) => item.key);
