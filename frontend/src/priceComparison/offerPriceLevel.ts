export type OfferPriceLevelTone = "below" | "above" | "high" | "neutral" | "none";

export type OfferPriceLevelPresentation = {
  tone: OfferPriceLevelTone;
  label: "darunter" | "darüber" | "gleichauf" | "Ohne Vergleich";
  meter: { left: number; width: number } | null;
};

/**
 * Maps the exact historic deviation onto the compact, capped +/-20% scale.
 * The exact percentage remains visible beside the scale; only the bar length
 * is capped so unusually large deviations cannot break the layout.
 */
export function offerPriceLevelPresentation(value: number | null | undefined): OfferPriceLevelPresentation {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { tone: "none", label: "Ohne Vergleich", meter: null };
  }

  if (value === 0) {
    return { tone: "neutral", label: "gleichauf", meter: { left: 50, width: 0 } };
  }

  const width = Math.min(50, Math.abs(value) / 20 * 50);
  if (value < 0) {
    return { tone: "below", label: "darunter", meter: { left: 50 - width, width } };
  }

  return {
    tone: value >= 10 ? "high" : "above",
    label: "darüber",
    meter: { left: 50, width },
  };
}

export function offerPriceLevelDisplayValue(value: number | null, formattedValue: string): string {
  return typeof value === "number" && Number.isFinite(value) && value !== 0 && Math.abs(value) < 0.005
    ? "<0,01 %"
    : formattedValue;
}
