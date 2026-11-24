const MINIMUM_SLOT_WIDTH = 32;
const MAXIMUM_BAR_WIDTH = 42;

/** Use actual CSS pixels so a dense history cannot squeeze bars together. */
export function getPriceChartLayout(pointCount: number, availableWidth: number) {
  const count = Math.max(0, Math.floor(pointCount));
  const viewportWidth = Math.max(1, Math.floor(availableWidth));
  const contentWidth = Math.max(viewportWidth, count * MINIMUM_SLOT_WIDTH);
  const slotWidth = contentWidth / Math.max(count, 1);

  return {
    viewportWidth,
    contentWidth,
    slotWidth,
    barWidth: Math.min(MAXIMUM_BAR_WIDTH, slotWidth * 0.625),
    visibleCapacity: Math.floor(viewportWidth / MINIMUM_SLOT_WIDTH),
    maxScroll: contentWidth - viewportWidth,
    labelStep: Math.max(1, Math.ceil(72 / slotWidth)),
  };
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
