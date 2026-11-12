export type MapPointLabelMode = "full" | "points";

/** Counts contain only enabled sites/people inside the current map bounds. */
export function mapPointLabelMode(visibleSites: number, visiblePeople: number): MapPointLabelMode {
  const visiblePoints = visibleSites + visiblePeople;
  return visiblePoints > 0 && visiblePoints < 15 ? "full" : "points";
}
