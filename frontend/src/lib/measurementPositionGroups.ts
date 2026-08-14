export type MeasurementSourceGroupItem = {
  id: number;
  position: string;
  source_file_name: string | null;
  source_invoice_number: string | null;
};

export type MeasurementSourceDocumentGroup<T extends MeasurementSourceGroupItem> = {
  key: string;
  label: string;
  items: T[];
};

export type DesktopMeasurementPositionGroupItem = MeasurementSourceGroupItem & {
  is_free_position: boolean;
  is_hidden: boolean;
};

export type DesktopMeasurementPositionGroup = {
  key: string;
  label: string;
  count: number;
  itemIds: Set<number>;
};

type MutableMeasurementSourceDocumentGroup<T extends MeasurementSourceGroupItem> = {
  key: string;
  items: T[];
  sortIndex: number;
  sourceFileName: string | null;
  sourceInvoiceNumber: string | null;
  supplementLabel: string | null;
};

export function buildMeasurementSourceDocumentGroups<T extends MeasurementSourceGroupItem>(
  items: readonly T[],
): MeasurementSourceDocumentGroup<T>[] {
  const grouped = new Map<string, MutableMeasurementSourceDocumentGroup<T>>();
  items.forEach((item, index) => {
    const sourceFileName = cleanMeasurementSourceValue(item.source_file_name);
    const sourceInvoiceNumber = cleanMeasurementSourceValue(item.source_invoice_number);
    const supplementLabel = extractMeasurementSupplementLabel(item.position);
    const sourceKey = buildMeasurementSourceDocumentKey(sourceFileName, sourceInvoiceNumber, supplementLabel)
      ?? `source:legacy:${supplementLabel ?? "main"}`;

    const group = grouped.get(sourceKey) ?? {
      key: sourceKey,
      items: [],
      sortIndex: index,
      sourceFileName,
      sourceInvoiceNumber,
      supplementLabel,
    };
    group.items.push(item);
    grouped.set(sourceKey, group);
  });

  const sourceGroups = [...grouped.values()];
  return sourceGroups
    .sort(compareMeasurementSourceDocumentGroups)
    .map((group, index) => ({
      key: group.key,
      label: group.supplementLabel
        ?? (index === 0 ? "Hauptangebot" : getMeasurementSupplementGroupLabel(group, index)),
      items: group.items,
    }));
}

function compareMeasurementSourceDocumentGroups<T extends MeasurementSourceGroupItem>(
  left: MutableMeasurementSourceDocumentGroup<T>,
  right: MutableMeasurementSourceDocumentGroup<T>,
): number {
  if (left.supplementLabel !== right.supplementLabel) {
    if (left.supplementLabel === null) {
      return -1;
    }
    if (right.supplementLabel === null) {
      return 1;
    }
    const leftNumber = Number(left.supplementLabel.slice(1));
    const rightNumber = Number(right.supplementLabel.slice(1));
    if (leftNumber !== rightNumber) {
      return leftNumber - rightNumber;
    }
  }
  return left.sortIndex - right.sortIndex;
}

export function buildDesktopMeasurementPositionGroups<T extends DesktopMeasurementPositionGroupItem>(
  items: readonly T[],
): DesktopMeasurementPositionGroup[] {
  const visibleItems = items.filter((item) => !item.is_hidden);
  const offerItems = visibleItems.filter((item) => !item.is_free_position);
  const manualItems = visibleItems.filter((item) => item.is_free_position);
  const sourceGroups = buildMeasurementSourceDocumentGroups(offerItems);

  return [
    createDesktopMeasurementPositionGroup("all", "Alle Positionen", visibleItems),
    ...sourceGroups.map((group) => createDesktopMeasurementPositionGroup(
      `offer:${group.key}`,
      group.label,
      group.items,
    )),
    ...(manualItems.length > 0
      ? [createDesktopMeasurementPositionGroup("manual", "Manuell erfasst", manualItems)]
      : []),
  ];
}

function buildMeasurementSourceDocumentKey(
  sourceFileName: string | null,
  sourceInvoiceNumber: string | null,
  supplementLabel: string | null,
): string | null {
  if (!sourceFileName && !sourceInvoiceNumber) {
    return null;
  }
  const normalizedFileName = sourceFileName?.toLocaleUpperCase("de-DE") ?? "";
  const normalizedInvoiceNumber = sourceInvoiceNumber?.toLocaleUpperCase("de-DE") ?? "";
  return `source:file:${normalizedFileName}\u0000invoice:${normalizedInvoiceNumber}\u0000supplement:${supplementLabel ?? "main"}`;
}

function createDesktopMeasurementPositionGroup<T extends MeasurementSourceGroupItem>(
  key: string,
  label: string,
  items: readonly T[],
): DesktopMeasurementPositionGroup {
  return {
    key,
    label,
    count: items.length,
    itemIds: new Set(items.map((item) => item.id)),
  };
}

function getMeasurementSupplementGroupLabel<T extends MeasurementSourceGroupItem>(
  group: MutableMeasurementSourceDocumentGroup<T>,
  supplementIndex: number,
): string {
  const positionLabel = getCommonMeasurementSupplementPositionLabel(group.items);
  if (positionLabel) {
    return positionLabel;
  }
  const metadataLabel = extractMeasurementSupplementLabel(
    `${group.sourceInvoiceNumber ?? ""} ${group.sourceFileName ?? ""}`,
  );
  return metadataLabel ?? `Nachtrag ${supplementIndex}`;
}

function getCommonMeasurementSupplementPositionLabel<T extends MeasurementSourceGroupItem>(items: readonly T[]): string | null {
  const labels = new Set(
    items
      .map((item) => extractMeasurementSupplementLabel(item.position))
      .filter((label): label is string => Boolean(label)),
  );
  return labels.size === 1 ? [...labels][0] : null;
}

function extractMeasurementSupplementLabel(value: string): string | null {
  const match = value.toLocaleUpperCase("de-DE").match(/(?:^|[^A-Z0-9])N[\s._-]*(\d+)(?=$|[^0-9])/);
  return match ? `N${Number(match[1])}` : null;
}

function cleanMeasurementSourceValue(value: string | null): string | null {
  const cleaned = value?.trim();
  return cleaned || null;
}
