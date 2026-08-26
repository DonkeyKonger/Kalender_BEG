export type MeasurementSuggestionAlignment = "left" | "right";

export const MEASUREMENT_SUGGESTION_WIDTH = 300;
export const MEASUREMENT_SUGGESTION_VIEWPORT_MARGIN = 8;
const MEASUREMENT_SUGGESTION_ANCHOR_INSET = 4;

export function getMeasurementSuggestionAlignment(
  anchor: Pick<DOMRect, "left">,
  viewportWidth: number,
): MeasurementSuggestionAlignment {
  const availablePopupWidth = Math.min(
    MEASUREMENT_SUGGESTION_WIDTH,
    Math.max(0, viewportWidth - MEASUREMENT_SUGGESTION_VIEWPORT_MARGIN * 2),
  );
  const rightEdge = anchor.left + MEASUREMENT_SUGGESTION_ANCHOR_INSET + availablePopupWidth;
  return rightEdge > viewportWidth - MEASUREMENT_SUGGESTION_VIEWPORT_MARGIN ? "left" : "right";
}
