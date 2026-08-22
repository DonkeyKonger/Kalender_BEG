export type ExtraWorkMaterialItem = {
  quantity: number | null;
  unit: string | null;
  description: string;
};

const EXTRA_WORK_MATERIAL_UNIT_PATTERN = "(?:stück|stk\\.?|mm|cm|kg|m|x)";
const EXTRA_WORK_MATERIAL_PATTERN = new RegExp(
  `^\\s*(\\d+(?:[.,]\\d+)?)\\s*(${EXTRA_WORK_MATERIAL_UNIT_PATTERN})\\s+(.+?)\\s*$`,
  "iu",
);

export function parseExtraWorkMaterialInput(value: string): ExtraWorkMaterialItem | null {
  const cleaned = value.trim().replace(/\s+/g, " ");
  if (!cleaned) {
    return null;
  }
  const match = cleaned.match(EXTRA_WORK_MATERIAL_PATTERN);
  if (!match) {
    return { quantity: null, unit: null, description: cleaned };
  }
  const quantity = Number(match[1].replace(",", "."));
  if (!Number.isFinite(quantity)) {
    return { quantity: null, unit: null, description: cleaned };
  }
  return {
    quantity,
    unit: normalizeExtraWorkMaterialUnit(match[2]),
    description: match[3].trim(),
  };
}

export function parseExtraWorkMaterialQuantity(value: string): number | null {
  const cleaned = value.trim().replace(",", ".");
  if (!cleaned) {
    return null;
  }
  const quantity = Number(cleaned);
  return Number.isFinite(quantity) && quantity >= 0 ? quantity : Number.NaN;
}

export function formatExtraWorkMaterialQuantity(
  quantity: number | null,
  unit: string | null,
): string {
  if (quantity === null || !Number.isFinite(quantity)) {
    return "";
  }
  const formatted = new Intl.NumberFormat("de-DE", {
    maximumFractionDigits: 3,
  }).format(quantity);
  return unit?.toLocaleLowerCase("de-DE") === "x"
    ? `${formatted}×`
    : [formatted, unit?.trim()].filter(Boolean).join(" ");
}

function normalizeExtraWorkMaterialUnit(value: string): string {
  const normalized = value.trim().replace(/\.$/, "").toLocaleLowerCase("de-DE");
  if (normalized === "stück" || normalized === "stk") {
    return "Stk";
  }
  return normalized;
}
