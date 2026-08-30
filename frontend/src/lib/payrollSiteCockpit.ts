import type {
  PayrollSiteActionItem,
  PayrollSiteCockpit,
  PayrollSiteCockpitSite,
  PayrollSiteHistory,
  PayrollSiteHistoryPoint,
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

export type PayrollSiteChartPoint = PayrollSiteHistoryPoint & {
  x: number;
  actualY: number;
  forecastY: number | null;
};

export type PayrollSiteChartTick = {
  value: number;
  position: number;
};

export type PayrollSiteHistoryChart = {
  actualPath: string;
  forecastPath: string | null;
  offerY: number | null;
  points: PayrollSiteChartPoint[];
  xTicks: PayrollSiteChartPoint[];
  yTicks: PayrollSiteChartTick[];
};

export type PayrollSiteHistoryView = {
  error: string | null;
  history: PayrollSiteHistory | null;
  isLoading: boolean;
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

export function formatPayrollSiteChartDate(value: string): string {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "UTC",
    year: "2-digit",
  }).format(parsed);
}

export function resolvePayrollSiteHistoryView({
  error,
  history,
  isLoading,
  requestKey,
  selectedRequestKey,
  selectedSiteId,
}: {
  error: string | null;
  history: PayrollSiteHistory | null;
  isLoading: boolean;
  requestKey: string | null;
  selectedRequestKey: string | null;
  selectedSiteId: number | null;
}): PayrollSiteHistoryView {
  if (selectedSiteId === null || selectedRequestKey === null) {
    return { error: null, history: null, isLoading: false };
  }
  if (requestKey !== selectedRequestKey) {
    return { error: null, history: null, isLoading: true };
  }
  return {
    error,
    history: history?.site_id === selectedSiteId ? history : null,
    isLoading,
  };
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

export function selectPayrollSiteId(
  currentSiteId: number | null,
  sites: PayrollSiteCockpitSite[],
  actionItems: PayrollSiteActionItem[],
): number | null {
  if (currentSiteId !== null && sites.some((site) => site.site_id === currentSiteId)) {
    return currentSiteId;
  }
  const riskSiteId = actionItems.find((item) => sites.some((site) => site.site_id === item.site_id))?.site_id;
  return riskSiteId ?? sites[0]?.site_id ?? null;
}

export function buildPayrollSiteHistoryChart(
  inputPoints: PayrollSiteHistoryPoint[],
  offerMinutes: number | null,
  dimensions: { width?: number; height?: number; left?: number; right?: number; top?: number; bottom?: number } = {},
): PayrollSiteHistoryChart {
  const width = dimensions.width ?? 920;
  const height = dimensions.height ?? 260;
  const left = dimensions.left ?? 58;
  const right = dimensions.right ?? 18;
  const top = dimensions.top ?? 16;
  const bottom = dimensions.bottom ?? 36;
  const plotWidth = Math.max(1, width - left - right);
  const plotHeight = Math.max(1, height - top - bottom);
  const points = [...inputPoints]
    .filter((point) => Number.isFinite(Date.parse(`${point.date}T00:00:00Z`)))
    .sort((first, second) => first.date.localeCompare(second.date));
  const maximumValue = Math.max(
    nullableNonNegative(offerMinutes) ?? 0,
    ...points.flatMap((point) => [nonNegative(point.actual_minutes), nullableNonNegative(point.forecast_minutes) ?? 0]),
    60,
  );
  const yStep = niceMinuteStep(maximumValue / 4);
  const yMaximum = Math.max(yStep, Math.ceil(maximumValue / yStep) * yStep);
  const yPosition = (value: number) => top + plotHeight - nonNegative(value) / yMaximum * plotHeight;
  const firstTimestamp = points.length ? Date.parse(`${points[0].date}T00:00:00Z`) : 0;
  const lastTimestamp = points.length ? Date.parse(`${points.at(-1)?.date}T00:00:00Z`) : 0;
  const timeSpan = Math.max(1, lastTimestamp - firstTimestamp);

  const chartPoints: PayrollSiteChartPoint[] = points.map((point) => {
    const timestamp = Date.parse(`${point.date}T00:00:00Z`);
    const x = points.length === 1 ? left + plotWidth : left + (timestamp - firstTimestamp) / timeSpan * plotWidth;
    return {
      ...point,
      x,
      actualY: yPosition(point.actual_minutes),
      forecastY: point.forecast_minutes === null ? null : yPosition(point.forecast_minutes),
    };
  });
  const tickStride = Math.max(1, Math.ceil(chartPoints.length / 6));
  const xTicks = chartPoints.filter((_, index) => index % tickStride === 0);
  const finalPoint = chartPoints.at(-1);
  if (finalPoint && !xTicks.includes(finalPoint)) {
    xTicks.push(finalPoint);
  }
  const yTicks = Array.from({ length: Math.floor(yMaximum / yStep) + 1 }, (_, index) => {
    const value = index * yStep;
    return { value, position: yPosition(value) };
  });

  return {
    actualPath: svgPath(chartPoints.map((point) => ({ x: point.x, y: point.actualY }))),
    forecastPath: svgPath(chartPoints.flatMap((point) => (
      point.forecastY === null ? [] : [{ x: point.x, y: point.forecastY }]
    ))) || null,
    offerY: offerMinutes === null ? null : yPosition(offerMinutes),
    points: chartPoints,
    xTicks,
    yTicks,
  };
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

function svgPath(points: { x: number; y: number }[]): string {
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${round(point.x)} ${round(point.y)}`).join(" ");
}

function niceMinuteStep(targetMinutes: number): number {
  const targetHours = Math.max(1, targetMinutes / 60);
  const magnitude = 10 ** Math.floor(Math.log10(targetHours));
  const normalized = targetHours / magnitude;
  const multiplier = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return multiplier * magnitude * 60;
}

function nullableNonNegative(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : Math.max(0, value);
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
