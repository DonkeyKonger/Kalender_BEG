const MINIMUM_SLOT_WIDTH = 32;
const BAR_WIDTH = 20;

/** Use actual CSS pixels so a dense history cannot squeeze bars together. */
export function getPriceChartLayout(pointCount: number, availableWidth: number, mode: "bars" | "line" = "bars") {
  const count = Math.max(0, Math.floor(pointCount));
  const viewportWidth = Math.max(1, Math.floor(availableWidth));
  const contentWidth = Math.max(viewportWidth, count * MINIMUM_SLOT_WIDTH);
  const slotWidth = mode === "bars" ? MINIMUM_SLOT_WIDTH : contentWidth / Math.max(count, 1);

  return {
    viewportWidth,
    contentWidth,
    slotWidth,
    barWidth: BAR_WIDTH,
    visibleCapacity: Math.floor(viewportWidth / MINIMUM_SLOT_WIDTH),
    maxScroll: contentWidth - viewportWidth,
    labelStep: Math.max(1, Math.ceil(72 / slotWidth)),
  };
}

/** Keep dates under their points, including short histories aligned to the left. */
export function getPriceChartDateLabels(layout: ReturnType<typeof getPriceChartLayout>, pointCount: number) {
  const labels: Array<{ index: number; x: number }> = [];
  const edgePadding = Math.min(24, layout.contentWidth / 2);
  for (let index = 0; index < pointCount; index += 1) {
    const regular = index % layout.labelStep === 0 && (index === 0 || index < pointCount - layout.labelStep);
    const last = index === pointCount - 1 && index >= layout.labelStep;
    if (regular || last) labels.push({
      index,
      x: Math.max(edgePadding, Math.min(layout.contentWidth - edgePadding, (index + 0.5) * layout.slotWidth)),
    });
  }
  return labels;
}

export function getPriceChartWindow(
  layout: ReturnType<typeof getPriceChartLayout>,
  pointCount: number,
  requestedScroll: number,
) {
  const scrollLeft = Math.max(0, Math.min(requestedScroll, layout.maxScroll));
  return {
    scrollLeft,
    first: Math.min(pointCount, Math.floor(scrollLeft / layout.slotWidth) + 1),
    last: Math.min(pointCount, Math.ceil((scrollLeft + layout.viewportWidth) / layout.slotWidth)),
  };
}

/** Reveal the selected offer once, without scrolling past the chart edges. */
export function getPriceChartOfferScroll(
  layout: ReturnType<typeof getPriceChartLayout>,
  pointIndex: number,
) {
  if (pointIndex < 0) return 0;
  return Math.max(0, Math.min(
    (pointIndex + 0.5) * layout.slotWidth - layout.viewportWidth / 2,
    layout.maxScroll,
  ));
}
