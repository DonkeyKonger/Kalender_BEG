import type { MobileMeasurementBatch } from "../types/site";
import { getExtraWorkOverviewPageWindow } from "./extraWorkOverview";

export type MeasurementOverviewState = { selectedId: number | null; query: string; page: number };

// Filter the complete server result before applying the local page window.
export function getMeasurementOverviewWindow(
  batches: MobileMeasurementBatch[], state: MeasurementOverviewState, pageSize: number,
  title: (batch: MobileMeasurementBatch) => string,
) {
  const query = state.query.trim().toLocaleLowerCase("de-DE");
  const filtered = batches.filter((batch) => !query || [
    title(batch), batch.title, batch.created_by_name, batch.submitted_by_name, batch.area_location,
  ].some((value) => value?.toLocaleLowerCase("de-DE").includes(query)));
  const selectedIndex = filtered.findIndex((batch) => batch.id === state.selectedId);
  const window = getExtraWorkOverviewPageWindow(filtered.length,
    selectedIndex >= 0 ? Math.floor(selectedIndex / pageSize) + 1 : state.page, pageSize);
  const visible = filtered.slice(window.start, window.end);
  const selected = visible.find((batch) => batch.id === state.selectedId) ?? visible[0] ?? null;
  return { filtered, visible, selected, ...window };
}

export function formatMeasurementCount(value: number | null | undefined, singular: string, plural: string) {
  return value === null || value === undefined ? `— ${plural}` : `${value} ${value === 1 ? singular : plural}`;
}
