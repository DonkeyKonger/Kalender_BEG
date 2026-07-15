import type { ToolMaterialStatus } from "../types/toolMaterial";

export const toolMaterialStatusOptions: ReadonlyArray<{
  value: ToolMaterialStatus;
  label: string;
  badgeClass: string;
}> = [
  { value: "issued", label: "Ausgegeben", badgeClass: "is-issued" },
  { value: "warehouse", label: "Lager", badgeClass: "is-warehouse" },
  { value: "defective", label: "Defekt", badgeClass: "is-defective" },
];

export function getToolMaterialStatusPresentation(status: ToolMaterialStatus) {
  return toolMaterialStatusOptions.find((option) => option.value === status)
    ?? toolMaterialStatusOptions[1];
}

export function getSuggestedToolMaterialStatus(
  currentStatus: ToolMaterialStatus,
  employeeId: string,
): ToolMaterialStatus {
  if (currentStatus === "defective") {
    return currentStatus;
  }
  if (employeeId && currentStatus === "warehouse") {
    return "issued";
  }
  if (!employeeId && currentStatus === "issued") {
    return "warehouse";
  }
  return currentStatus;
}
