export type ExtraWorkMaterialItem = {
  quantity: number | null;
  unit: string | null;
  description: string;
};

export type RehydratedExtraWorkMaterialItem = ExtraWorkMaterialItem & {
  id: string;
};

const EXTRA_WORK_MATERIAL_UNIT_GROUPS = [
  { canonical: "Stk", aliases: ["st", "stk", "stck", "stück", "stueck", "stückzahl", "stueckzahl"] },
  { canonical: "x", aliases: ["x"] },
  { canonical: "m", aliases: ["m", "meter", "lfm"] },
  { canonical: "mm", aliases: ["mm"] },
  { canonical: "cm", aliases: ["cm"] },
  { canonical: "kg", aliases: ["kg"] },
  { canonical: "g", aliases: ["g"] },
  { canonical: "Std", aliases: ["h", "std", "stunde", "stunden"] },
  { canonical: "Rolle", aliases: ["rolle", "rollen"] },
  { canonical: "Bund", aliases: ["bund", "bünde", "buende"] },
  { canonical: "Karton", aliases: ["karton", "kartons"] },
  { canonical: "Paket", aliases: ["paket", "pakete"] },
  { canonical: "Packung", aliases: ["packung", "packungen"] },
  { canonical: "Set", aliases: ["set", "sets"] },
  { canonical: "Satz", aliases: ["satz", "sätze", "saetze"] },
  { canonical: "Paar", aliases: ["paar"] },
] as const;

const EXTRA_WORK_MATERIAL_UNIT_ALIASES = new Map<string, string>(
  EXTRA_WORK_MATERIAL_UNIT_GROUPS.flatMap(({ canonical, aliases }) => (
    aliases.map((alias) => [alias, canonical] as const)
  )),
);
const EXTRA_WORK_MATERIAL_UNIT_PATTERN = `(?:${[...EXTRA_WORK_MATERIAL_UNIT_ALIASES.keys()]
  .sort((left, right) => right.length - left.length)
  .map((alias) => `${escapeRegularExpression(alias)}\\.?`)
  .join("|")})`;
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

export function rehydrateExtraWorkMaterialItems(
  items: readonly ExtraWorkMaterialItem[] | null | undefined,
  createId: () => string,
): RehydratedExtraWorkMaterialItem[] {
  return (items ?? []).map((item) => ({
    id: createId(),
    quantity: item.quantity ?? null,
    unit: item.unit ?? null,
    description: item.description,
  }));
}

export function formatExtraWorkDocumentMaterialText(
  materialText: string | null | undefined,
  materialItems: readonly ExtraWorkMaterialItem[] | null | undefined,
): string {
  const sections: string[] = [];
  const legacyText = (materialText ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
  if (legacyText) {
    sections.push(legacyText);
  }
  const itemLines = (materialItems ?? []).flatMap((item) => {
    const description = cleanExtraWorkMaterialInlineText(item.description);
    if (!description) {
      return [];
    }
    if (item.quantity === null || !Number.isFinite(item.quantity)) {
      return [description];
    }
    const quantity = formatExtraWorkPdfMaterialQuantity(item.quantity);
    const unit = cleanExtraWorkMaterialInlineText(item.unit ?? "");
    const quantityLabel = unit.toLocaleLowerCase("de-DE") === "x"
      ? `${quantity}x`
      : [quantity, unit].filter(Boolean).join(" ");
    return [`${quantityLabel} ${description}`];
  });
  if (itemLines.length > 0) {
    sections.push(itemLines.join("; "));
  }
  return sections.join("\n");
}

function formatExtraWorkPdfMaterialQuantity(quantity: number): string {
  return new Intl.NumberFormat("de-DE", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(Number(quantity.toFixed(2)));
}

function cleanExtraWorkMaterialInlineText(value: string): string {
  return value.replace(/\r/g, " ").trim().replace(/\s+/g, " ");
}

function normalizeExtraWorkMaterialUnit(value: string): string {
  const normalized = value.trim().replace(/\.$/, "").toLocaleLowerCase("de-DE");
  return EXTRA_WORK_MATERIAL_UNIT_ALIASES.get(normalized) ?? normalized;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
