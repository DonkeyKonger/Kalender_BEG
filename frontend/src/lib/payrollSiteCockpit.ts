import type {
  PayrollSiteActionItem,
  PayrollSiteCockpit,
  PayrollSiteCockpitSite,
} from "../types/timeEntry";

export type PayrollSiteTrackLayout = {
  actualWithinPercent: number;
  actualOverrunLeftPercent: number;
  actualOverrunPercent: number;
  forecastWithinLeftPercent: number;
  forecastWithinPercent: number;
  forecastOverrunLeftPercent: number;
  forecastOverrunPercent: number;
  budgetMarkerPercent: number | null;
};

const RISK_ORDER: Record<PayrollSiteCockpitSite["risk_level"], number> = {
  critical: 0,
  warning: 1,
  missing_data: 2,
  none: 3,
};

export function payrollSiteLabel(site: Pick<PayrollSiteCockpitSite, "site_name" | "site_number">): string {
  return site.site_number ? `${site.site_number} · ${site.site_name}` : site.site_name;
}

export function roundPayrollSiteMinutes(minutes: number | null | undefined): number | null {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) {
    return null;
  }
  const sign = minutes < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(minutes));
}

export function formatPayrollSiteMinutes(minutes: number | null | undefined): string {
  const roundedMinutes = roundPayrollSiteMinutes(minutes);
  if (roundedMinutes === null) {
    return "-";
  }
  const sign = roundedMinutes < 0 ? "−" : "";
  const absoluteMinutes = Math.abs(roundedMinutes);
  const hours = Math.floor(absoluteMinutes / 60);
  const remainingMinutes = absoluteMinutes % 60;
  if (hours === 0) {
    return `${sign}${remainingMinutes} Min.`;
  }
  return `${sign}${hours} Std. ${remainingMinutes} Min.`;
}

export function formatPayrollSiteSignedMinutes(minutes: number | null | undefined): string {
  const roundedMinutes = roundPayrollSiteMinutes(minutes);
  if (roundedMinutes === null) {
    return "-";
  }
  if (roundedMinutes === 0) {
    return formatPayrollSiteMinutes(0);
  }
  return `${roundedMinutes > 0 ? "+" : "−"}${formatPayrollSiteMinutes(Math.abs(roundedMinutes))}`;
}

export function buildPayrollSiteTrackLayout(site: Pick<
  PayrollSiteCockpitSite,
  "actual_minutes" | "forecast_minutes" | "offer_minutes"
>, scaleMinutes?: number): PayrollSiteTrackLayout {
  const actual = nonNegative(site.actual_minutes);
  const offer = nullableNonNegative(site.offer_minutes);
  const forecast = nullableNonNegative(site.forecast_minutes);
  const scale = Math.max(actual, offer ?? 0, forecast ?? 0, nonNegative(scaleMinutes ?? 0), 1);
  const toPercent = (minutes: number) => Math.min(100, Math.max(0, minutes / scale * 100));

  const actualWithin = offer === null ? actual : Math.min(actual, offer);
  const actualOverrun = offer === null ? 0 : Math.max(0, actual - offer);
  const forecastStart = Math.max(actual, 0);
  const forecastEnd = forecast === null ? forecastStart : Math.max(forecastStart, forecast);
  const forecastWithinEnd = offer === null ? forecastEnd : Math.min(forecastEnd, offer);
  const forecastWithinStart = offer === null ? forecastStart : Math.min(forecastStart, offer);
  const forecastOverrunStart = offer === null ? forecastEnd : Math.max(forecastStart, offer);

  return {
    actualWithinPercent: toPercent(actualWithin),
    actualOverrunLeftPercent: offer === null ? 0 : toPercent(offer),
    actualOverrunPercent: toPercent(actualOverrun),
    forecastWithinLeftPercent: toPercent(forecastWithinStart),
    forecastWithinPercent: toPercent(Math.max(0, forecastWithinEnd - forecastWithinStart)),
    forecastOverrunLeftPercent: toPercent(forecastOverrunStart),
    forecastOverrunPercent: offer === null ? 0 : toPercent(Math.max(0, forecastEnd - forecastOverrunStart)),
    budgetMarkerPercent: offer === null ? null : toPercent(offer),
  };
}

export function payrollSitePortfolioScale(sites: PayrollSiteCockpitSite[]): number {
  return Math.max(
    1,
    ...sites.flatMap((site) => [
      nonNegative(site.actual_minutes),
      nullableNonNegative(site.offer_minutes) ?? 0,
      nullableNonNegative(site.forecast_minutes) ?? 0,
    ]),
  );
}

export function resolvePayrollSiteActionItems(
  cockpit: PayrollSiteCockpit,
  limit = 3,
): PayrollSiteActionItem[] {
  if (cockpit.action_items.length > 0) {
    return [...cockpit.action_items]
      .sort((left, right) => left.rank - right.rank || left.site_name.localeCompare(right.site_name, "de"))
      .slice(0, limit);
  }
  return buildPayrollSiteActionItems(cockpit.sites, limit);
}

export function buildPayrollSiteActionItems(
  sites: PayrollSiteCockpitSite[],
  limit = 3,
): PayrollSiteActionItem[] {
  return sites
    .filter((site) => site.risk_level !== "none")
    .sort((left, right) => (
      RISK_ORDER[left.risk_level] - RISK_ORDER[right.risk_level]
      || (right.variance_minutes ?? Number.NEGATIVE_INFINITY) - (left.variance_minutes ?? Number.NEGATIVE_INFINITY)
      || (right.utilization_percent ?? Number.NEGATIVE_INFINITY) - (left.utilization_percent ?? Number.NEGATIVE_INFINITY)
      || payrollSiteLabel(left).localeCompare(payrollSiteLabel(right), "de")
    ))
    .slice(0, limit)
    .map((site, index) => ({
      rank: index + 1,
      site_id: site.site_id,
      site_number: site.site_number,
      site_name: site.site_name,
      risk_level: site.risk_level === "none" ? "missing_data" : site.risk_level,
      reason: site.risk_reason || fallbackRiskReason(site),
      variance_minutes: site.variance_minutes,
      utilization_percent: site.utilization_percent,
    }));
}

function fallbackRiskReason(site: PayrollSiteCockpitSite): string {
  if (site.offer_minutes === null) {
    return "Angebotsstunden fehlen";
  }
  const actualOverrun = site.actual_minutes - site.offer_minutes;
  if (actualOverrun > 0) {
    return `Ist liegt ${formatPayrollSiteMinutes(actualOverrun)} über Angebot`;
  }
  if (site.forecast_minutes !== null && site.forecast_minutes > site.offer_minutes) {
    const forecastOverrun = site.forecast_minutes - site.offer_minutes;
    return `Prognose liegt ${formatPayrollSiteMinutes(forecastOverrun)} über Angebot`;
  }
  if (site.variance_minutes !== null && site.variance_minutes > 0) {
    return `${formatPayrollSiteMinutes(site.variance_minutes)} über Angebot`;
  }
  if (site.utilization_percent !== null) {
    return `${Math.round(site.utilization_percent)} % des Angebots verbraucht`;
  }
  return "Datengrundlage prüfen";
}

function nullableNonNegative(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : Math.max(0, value);
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
