// Pro Max reference: 1320 physical pixels / 3 = 440 logical screen pixels.
// Compare the short edge, not the current viewport (rotation, keyboard, split view).
export const PHONE_REFERENCE_SHORT_EDGE = 440;

export function usesMeasurementTable(screenWidth: number, screenHeight: number): boolean {
  return Number.isFinite(screenWidth) && Number.isFinite(screenHeight)
    && Math.min(screenWidth, screenHeight) > PHONE_REFERENCE_SHORT_EDGE;
}
