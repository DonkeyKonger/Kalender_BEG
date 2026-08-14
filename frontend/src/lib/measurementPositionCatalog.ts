import type { MeasurementItem } from "../types/site";

export type MeasurementPositionCatalogEntry = {
  id: number;
  position: string;
  description: string;
  unit: string | null;
};

export function getMeasurementPositionCatalogKey(position: string): string {
  return position.trim().replace(/\s+/g, " ").toLocaleLowerCase("de-DE");
}

export function buildMeasurementPositionCatalog(
  items: readonly MeasurementItem[],
): MeasurementPositionCatalogEntry[] {
  return items
    .filter((item) => !item.is_free_position && !item.is_hidden)
    .sort((left, right) => left.sort_order - right.sort_order || left.id - right.id)
    .map((item) => ({
      id: item.id,
      position: item.position,
      description: item.description,
      unit: item.unit,
    }));
}
