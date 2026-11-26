import type { OfferComparisonQuality, OfferComparisonUnavailableReason } from "./client";

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

export type OfferComparisonQualityPresentation = {
  unavailableLabel: "Ohne Vergleich" | "Keine belastbare Vergleichsbasis";
  summary: string | null;
  tooltip: string | null;
};

const qualityNumberFormatter = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 1 });
const qualityIntegerFormatter = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });
const unavailableReasonLabels: Record<OfferComparisonUnavailableReason, string> = {
  insufficient_references: "Zu wenige historische Erstangebote",
  insufficient_coverage: "Wertabdeckung unter 60 %",
  invalid_prices: "Fehlende oder ungültige Preise",
  invalid_date: "Ungültiges Angebotsdatum",
  no_comparable_positions: "Keine vergleichbaren Positionen",
};

function qualityPercent(value: number): string {
  return Number.isFinite(value) ? `${qualityNumberFormatter.format(value)} %` : "—";
}

function qualityInteger(value: number): string {
  return Number.isFinite(value) ? qualityIntegerFormatter.format(value) : "—";
}

function qualityDate(value: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value || "—";
}

export function offerComparisonQualityPresentation(quality?: OfferComparisonQuality | null): OfferComparisonQualityPresentation {
  if (!quality) return { unavailableLabel: "Ohne Vergleich", summary: null, tooltip: null };

  const reason = quality.reason ? unavailableReasonLabels[quality.reason] ?? "Vergleichsbasis nicht belastbar" : "Vergleichsbasis nicht belastbar";
  const summary = quality.status === "reliable"
    ? `${qualityInteger(quality.matched_positions)}/${qualityInteger(quality.eligible_positions)} Artikel · ${qualityPercent(quality.value_coverage_pct)} Wertabdeckung`
    : reason;
  const details = [
    quality.status === "reliable" ? "Belastbare Vergleichsbasis" : `Keine belastbare Vergleichsbasis: ${reason}`,
    `Verglichen: ${qualityInteger(quality.matched_positions)} von ${qualityInteger(quality.eligible_positions)} prüfbaren Artikeln`,
    `Gesamtpositionen: ${qualityInteger(quality.total_positions)}`,
    `Wertabdeckung: ${qualityPercent(quality.value_coverage_pct)}`,
    `Positionsabdeckung: ${qualityPercent(quality.position_coverage_pct)}`,
    `Historische Erstangebote: ${qualityInteger(quality.reference_offer_count)}`,
    `Ausgeschlossen: ${qualityInteger(quality.excluded_positions)} Positionen`,
    `Methode: ${quality.method_version || "—"}`,
    `Stand: ${qualityDate(quality.as_of)}`,
    `Fenster ab: ${qualityDate(quality.window_start)}`,
  ];

  return {
    unavailableLabel: quality.status === "unavailable" ? "Keine belastbare Vergleichsbasis" : "Ohne Vergleich",
    summary,
    tooltip: details.join(" · "),
  };
}
