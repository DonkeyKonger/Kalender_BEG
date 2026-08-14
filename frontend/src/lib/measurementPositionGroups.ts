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

type MutableMeasurementSourceDocumentGroup<T extends MeasurementSourceGroupItem> = {
  key: string;
  items: T[];
  sortIndex: number;
  sourceFileName: string | null;
  sourceInvoiceNumber: string | null;
};

export function buildMeasurementSourceDocumentGroups<T extends MeasurementSourceGroupItem>(
  items: readonly T[],
): MeasurementSourceDocumentGroup<T>[] {
  const grouped = new Map<string, MutableMeasurementSourceDocumentGroup<T>>();
  const itemsWithoutSource: T[] = [];
  let firstItemWithoutSourceIndex = Number.MAX_SAFE_INTEGER;

  items.forEach((item, index) => {
    const sourceFileName = cleanMeasurementSourceValue(item.source_file_name);
    const sourceInvoiceNumber = cleanMeasurementSourceValue(item.source_invoice_number);
    const sourceKey = buildMeasurementSourceDocumentKey(sourceFileName, sourceInvoiceNumber);
    if (!sourceKey) {
      itemsWithoutSource.push(item);
      firstItemWithoutSourceIndex = Math.min(firstItemWithoutSourceIndex, index);
      return;
    }

    const group = grouped.get(sourceKey) ?? {
      key: sourceKey,
      items: [],
      sortIndex: index,
      sourceFileName,
      sourceInvoiceNumber,
    };
    group.items.push(item);
    grouped.set(sourceKey, group);
  });

  const sourceGroups = [...grouped.values()];
  if (sourceGroups.length === 0) {
    return [];
  }
  if (itemsWithoutSource.length > 0) {
    sourceGroups.push({
      key: "source:legacy",
      items: itemsWithoutSource,
      sortIndex: firstItemWithoutSourceIndex,
      sourceFileName: null,
      sourceInvoiceNumber: null,
    });
  }

  return sourceGroups
    .sort((left, right) => left.sortIndex - right.sortIndex)
    .map((group, index) => ({
      key: group.key,
      label: index === 0
        ? "Hauptangebot"
        : getMeasurementSupplementGroupLabel(group, index),
      items: group.items,
    }));
}

function buildMeasurementSourceDocumentKey(
  sourceFileName: string | null,
  sourceInvoiceNumber: string | null,
): string | null {
  if (!sourceFileName && !sourceInvoiceNumber) {
    return null;
  }
  const normalizedFileName = sourceFileName?.toLocaleUpperCase("de-DE") ?? "";
  const normalizedInvoiceNumber = sourceInvoiceNumber?.toLocaleUpperCase("de-DE") ?? "";
  return `source:file:${normalizedFileName}\u0000invoice:${normalizedInvoiceNumber}`;
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
