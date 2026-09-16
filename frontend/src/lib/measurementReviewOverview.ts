import type { MeasurementGroup, MobileMeasurementBatch } from "../types/site";
import { getExtraWorkOverviewPageWindow } from "./extraWorkOverview";

export type MeasurementOverviewState = { selectedId: number | null; query: string; page: number };

export function isMeasurementCompleted(batch: MobileMeasurementBatch) {
  return ["billed", "approved", "closed", "completed", "finalized", "abgeschlossen"].includes(batch.status) && !batch.deleted_at;
}

export function getMeasurementGroups(batches: MobileMeasurementBatch[]) {
  const byId = new Map(batches.map(batch => [batch.id, batch]));
  const groups = new Map<number, MeasurementGroup>();
  for (const batch of batches) {
    const group = batch.combined_measurement;
    // A mutation response has no group metadata: dissolve the whole visual group
    // immediately, even before the next complete overview reload.
    if (group && group.sources.length >= 2 && group.sources.every(source => {
      const member = byId.get(source.id);
      return member && isMeasurementCompleted(member) && member.combined_measurement?.id === group.id;
    })) groups.set(group.id, group);
  }
  return groups;
}

export function getMeasurementOverviewTitle(batch: MobileMeasurementBatch, numberTitle: string): string {
  const hint = batch.origin === "OFFICE" ? batch.area_location?.trim().replace(/\s+/g, " ") : null;
  return hint ? `${numberTitle} - ${hint}` : numberTitle;
}

export function getMeasurementOfferDisplay(batch: MobileMeasurementBatch) {
  const offerId = batch.offer_id ?? batch.measurement_base_id;
  if (offerId == null) {
    return { kind: "none" as const, name: "Ohne Angebotszuordnung" };
  }
  return {
    kind: batch.is_current_offer ? "current" as const : "older" as const,
    name: batch.offer_name?.trim() || batch.measurement_base_name?.trim() || `Angebot #${offerId}`,
  };
}

// Use actual wrapped chip positions, not a fixed item count or viewport breakpoint.
export function getMeasurementLocationPreviewCount(rowTops: number[]): number {
  let row = 0;
  let previousTop = -Infinity;
  for (let index = 0; index < rowTops.length; index += 1) {
    if (Math.abs(rowTops[index] - previousTop) > 1) {
      row += 1;
      previousTop = rowTops[index];
    }
    if (row > 2) return index;
  }
  return rowTops.length;
}

// Filter and sort the complete server result before applying the local page window.
export function getMeasurementOverviewWindow(
  batches: MobileMeasurementBatch[], state: MeasurementOverviewState, pageSize: number,
  title: (batch: MobileMeasurementBatch) => string,
) {
  const query = state.query.trim().toLocaleLowerCase("de-DE");
  const groups = getMeasurementGroups(batches);
  if (groups.size) return groupedWindow(batches, state, pageSize, title, groups, query);
  const filtered = batches.filter((batch) => !query || [
    title(batch), batch.title, batch.created_by_name, batch.submitted_by_name, batch.area_location,
  ].some((value) => value?.toLocaleLowerCase("de-DE").includes(query)))
    // Number is the fixed chronology; submitting or reviewing must never move a row.
    .sort((left, right) => right.number - left.number || right.id - left.id);
  const selectedIndex = filtered.findIndex((batch) => batch.id === state.selectedId);
  const window = getExtraWorkOverviewPageWindow(filtered.length,
    selectedIndex >= 0 ? Math.floor(selectedIndex / pageSize) + 1 : state.page, pageSize);
  const visible = filtered.slice(window.start, window.end);
  const selected = visible.find((batch) => batch.id === state.selectedId) ?? visible[0] ?? null;
  return { filtered, visible, selected, groups, ...window };
}

function groupedWindow(batches: MobileMeasurementBatch[], state: MeasurementOverviewState, pageSize: number,
  title: (batch: MobileMeasurementBatch) => string, groups: Map<number, MeasurementGroup>, query: string) {
  const sorted = [...batches].sort((a, b) => b.number - a.number || b.id - a.id);
  const visited = new Set<number>();
  const units: MobileMeasurementBatch[][] = [];
  for (const batch of sorted) {
    if (visited.has(batch.id)) continue;
    const group = groups.get(batch.combined_measurement?.id ?? -1);
    const unit = group ? sorted.filter(row => group.sources.some(source => source.id === row.id)) : [batch];
    unit.forEach(row => visited.add(row.id));
    if (!query || [group?.number_label, ...unit.flatMap(row => [title(row), row.title, row.created_by_name, row.submitted_by_name, row.area_location])]
      .some(value => value?.toLocaleLowerCase("de-DE").includes(query))) units.push(unit);
  }
  // Keep headers and their originals together. Large groups get their own,
  // scrollable page rather than losing their header across a page boundary.
  const pages: MobileMeasurementBatch[][] = [];
  let current: MobileMeasurementBatch[] = [], rows = 0;
  for (const unit of units) {
    const cost = unit.length + (unit.length > 1 ? 1 : 0);
    if (current.length && rows + cost > pageSize) { pages.push(current); current = []; rows = 0; }
    current.push(...unit); rows += cost;
  }
  if (current.length) pages.push(current);
  const selectedPage = pages.findIndex(page => page.some(batch => batch.id === state.selectedId));
  const pageCount = Math.max(1, pages.length);
  const page = selectedPage >= 0 ? selectedPage + 1 : Math.min(pageCount, Math.max(1, state.page));
  const visible = pages[page - 1] ?? [];
  const filtered = units.flat();
  const start = pages.slice(0, page - 1).reduce((sum, rows) => sum + rows.length, 0);
  return { filtered, visible, groups, selected: visible.find(batch => batch.id === state.selectedId) ?? visible[0] ?? null,
    page, pageCount, start, end: start + visible.length };
}

export function formatMeasurementCount(value: number | null | undefined, singular: string, plural: string) {
  return value === null || value === undefined ? `— ${plural}` : `${value} ${value === 1 ? singular : plural}`;
}

// Use the server's quantity × calculation-time total, not entry counts or tracked time.
export function formatMeasurementDetailHours(value: MobileMeasurementBatch["reported_hours"] | undefined) {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return "—";
  const hours = Number(value);
  return Number.isFinite(hours)
    ? `${new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(hours)} h`
    : "—";
}

export function formatMeasurementOverviewHours(value: MobileMeasurementBatch["reported_hours"] | undefined) {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return "—";
  const hours = Number(value);
  // Overview only: drop fractional hours without rounding or changing server totals.
  return Number.isFinite(hours)
    ? `${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 }).format(Math.trunc(hours) || 0)} h`
    : "—";
}
