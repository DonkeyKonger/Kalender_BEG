import type {
  ToolMaterialItem,
  ToolMaterialItemUpdate,
  ToolMaterialStatus,
} from "../types/toolMaterial";

export const toolMaterialStatusOptions: ReadonlyArray<{
  value: ToolMaterialStatus;
  label: string;
  badgeClass: string;
}> = [
  { value: "issued", label: "Ausgegeben", badgeClass: "is-issued" },
  { value: "warehouse", label: "Lager", badgeClass: "is-warehouse" },
  { value: "written_off", label: "Ausgebucht", badgeClass: "is-written-off" },
];

export function getToolMaterialStatusPresentation(status: ToolMaterialStatus) {
  return toolMaterialStatusOptions.find((option) => option.value === status)
    ?? toolMaterialStatusOptions[1];
}

export function getSuggestedToolMaterialStatus(
  currentStatus: ToolMaterialStatus,
  employeeId: string,
): ToolMaterialStatus {
  if (employeeId) {
    return "issued";
  }
  if (!employeeId && currentStatus === "issued") {
    return "warehouse";
  }
  return currentStatus;
}

export function getToolMaterialStatusChange(status: ToolMaterialStatus): {
  status: ToolMaterialStatus;
  employee_id?: "";
} {
  return status === "issued" ? { status } : { status, employee_id: "" };
}

export function getToolMaterialStatusUpdate(status: ToolMaterialStatus): ToolMaterialItemUpdate {
  return status === "issued" ? { status } : { status, employee_id: null };
}

export function getOptimisticToolMaterialStatusItem(
  item: ToolMaterialItem,
  status: ToolMaterialStatus,
): ToolMaterialItem {
  return {
    ...item,
    status,
    ...(status === "issued" ? {} : { employee_id: null, employee: null }),
  };
}

export type ToolMaterialStatusSaveResult =
  | { ok: true; item: ToolMaterialItem }
  | { ok: false; item: ToolMaterialItem; error: unknown };

export async function saveToolMaterialStatus(
  item: ToolMaterialItem,
  status: ToolMaterialStatus,
  updateItem: (itemId: number, payload: ToolMaterialItemUpdate) => Promise<ToolMaterialItem>,
): Promise<ToolMaterialStatusSaveResult> {
  try {
    return {
      ok: true,
      item: await updateItem(item.id, getToolMaterialStatusUpdate(status)),
    };
  } catch (error) {
    return { ok: false, item, error };
  }
}
