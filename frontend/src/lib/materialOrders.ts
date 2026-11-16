import type { ProjectFolderDocumentItem } from "../types/site";

export type MaterialOrderValue = string | boolean;

export type MaterialOrderValues = Record<string, MaterialOrderValue>;

export type MaterialOrderDraft = {
  id: string;
  site_id: number;
  revision: number;
  values: MaterialOrderValues;
  status: "draft" | "completed";
  completion_pending: boolean;
  document: ProjectFolderDocumentItem | null;
  filename: string | null;
  updated_at: string;
};

export type MaterialOrderField = {
  name: string;
  label: string;
  type: "text" | "checkbox";
  rect: [number, number, number, number];
  max_length: number | null;
};

export type MaterialOrderForm = {
  width: number;
  height: number;
  fields: MaterialOrderField[];
};

export type MaterialOrderSavePayload = {
  revision: number;
  values: MaterialOrderValues;
};

export type MaterialOrderRecovery = {
  draftId: string;
  revision: number;
  values: MaterialOrderValues;
  savedAt: string;
};

export const MATERIAL_ORDER_ZOOM_LEVELS = [75, 90, 100, 110, 125, 150] as const;

export function materialOrderRectStyle(
  rect: MaterialOrderField["rect"],
  form: Pick<MaterialOrderForm, "width" | "height">,
): { left: string; top: string; width: string; height: string } {
  const [x, y, width, height] = rect;
  return {
    left: `${(x / form.width) * 100}%`,
    top: `${(y / form.height) * 100}%`,
    width: `${(width / form.width) * 100}%`,
    height: `${(height / form.height) * 100}%`,
  };
}

export function normalizeMaterialOrderValues(
  form: MaterialOrderForm,
  values: MaterialOrderValues | null | undefined,
): MaterialOrderValues {
  const source = values ?? {};
  return Object.fromEntries(form.fields.map((field) => {
    const value = source[field.name];
    if (field.type === "checkbox") {
      return [field.name, typeof value === "boolean" ? value : false];
    }
    return [field.name, typeof value === "string" ? value : ""];
  }));
}

export function materialOrderValuesEqual(left: MaterialOrderValues, right: MaterialOrderValues): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => right[key] === left[key]);
}

export function getMaterialOrderRecoveryKey(siteId: number, userId: number | null | undefined): string {
  return `kb_material_order_recovery:${siteId}:${userId ?? "anonymous"}`;
}

export function readMaterialOrderRecovery(
  storage: Pick<Storage, "getItem">,
  key: string,
): MaterialOrderRecovery | null {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || typeof parsed.draftId !== "string" || !Number.isInteger(parsed.revision)) {
      return null;
    }
    if (!isRecord(parsed.values) || typeof parsed.savedAt !== "string") {
      return null;
    }
    const values: MaterialOrderValues = {};
    for (const [name, value] of Object.entries(parsed.values)) {
      if (typeof value === "string" || typeof value === "boolean") {
        values[name] = value;
      }
    }
    return {
      draftId: parsed.draftId,
      revision: parsed.revision as number,
      values,
      savedAt: parsed.savedAt,
    };
  } catch {
    return null;
  }
}

export function writeMaterialOrderRecovery(
  storage: Pick<Storage, "setItem">,
  key: string,
  recovery: MaterialOrderRecovery,
): boolean {
  try {
    storage.setItem(key, JSON.stringify(recovery));
    return true;
  } catch {
    // Storage can be unavailable or full. Autosave remains the primary persistence path.
    return false;
  }
}

export function clearMaterialOrderRecovery(
  storage: Pick<Storage, "removeItem">,
  key: string,
): void {
  try {
    storage.removeItem(key);
  } catch {
    // A stale recovery entry is harmless and remains scoped to this user and site.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
