import type { MeasurementItem } from "../types/site";

export function filterMeasurementOfferPositions(items: readonly MeasurementItem[], query: string): MeasurementItem[] {
  const words = query.trim().toLocaleLowerCase("de-DE").split(/\s+/).filter(Boolean);
  return items.filter(item => {
    if (item.is_hidden || item.is_free_position) return false;
    const text = `${item.position} ${item.description} ${item.unit ?? ""}`.toLocaleLowerCase("de-DE");
    return words.every(word => text.includes(word));
  }).sort((left, right) => left.sort_order - right.sort_order || left.id - right.id);
}
