export type MapPointLabelMode = "full" | "points";

/** Counts contain only enabled sites/people inside the current map bounds. */
export function mapPointLabelMode(visibleSites: number, visiblePeople: number): MapPointLabelMode {
  const visiblePoints = visibleSites + visiblePeople;
  return visiblePoints > 0 && visiblePoints < 15 ? "full" : "points";
}

/** Once shown, labels survive panning until a different zoom level is reached. */
export function mapPointLabelModeAfterMove(
  previous: { mode: MapPointLabelMode; zoom: number },
  next: { sites: number; persons: number; zoom: number },
): MapPointLabelMode {
  if (previous.mode === "full" && previous.zoom === next.zoom) {
    return "full";
  }
  return mapPointLabelMode(next.sites, next.persons);
}
