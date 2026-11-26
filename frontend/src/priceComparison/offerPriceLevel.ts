export type OfferPriceLevelTone = "below" | "above" | "high" | "neutral" | "none";

export type OfferPriceLevelPresentation = {
  tone: OfferPriceLevelTone;
  label: "darunter" | "darüber" | "gleichauf" | "Ohne Vergleich";
};

/** Assign the comparison label and color without changing the historic deviation. */
export function offerPriceLevelPresentation(value: number | null | undefined): OfferPriceLevelPresentation {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { tone: "none", label: "Ohne Vergleich" };
  }

  if (value === 0) {
    return { tone: "neutral", label: "gleichauf" };
  }

  if (value < 0) {
    return { tone: "below", label: "darunter" };
  }

  return {
    tone: value >= 10 ? "high" : "above",
    label: "darüber",
  };
}

export function offerPriceLevelDisplayValue(value: number | null, formattedValue: string): string {
  return typeof value === "number" && Number.isFinite(value) && value !== 0 && Math.abs(value) < 0.005
    ? "<0,01 %"
    : formattedValue;
}
