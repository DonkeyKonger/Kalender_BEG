import type {
  ExtraWorkTicketEntrySummary,
  MobileExtraWorkTicket,
  MobileExtraWorkTicketEntry,
  Site,
} from "../types/site";

export const EXTRA_WORK_OVERVIEW_PAGE_SIZE = 8;

export function formatExtraWorkOverviewTitle(ticket: MobileExtraWorkTicket): string {
  return `Zusatzauftrag ${ticket.display_number}`;
}

export function getExtraWorkOverviewPrimaryEntry(
  ticket: MobileExtraWorkTicket,
): ExtraWorkTicketEntrySummary | null {
  return ticket.entry_summaries?.[0] ?? null;
}

export function buildExtraWorkOverviewEntrySummary(
  entry: MobileExtraWorkTicketEntry,
): ExtraWorkTicketEntrySummary {
  return {
    id: entry.id,
    component: entry.component,
    floor: entry.floor,
    room_number: entry.room_number ?? null,
    axis: entry.axis ?? null,
    remarks: entry.remarks ?? null,
    material_text: entry.material_text ?? null,
    material_descriptions: (entry.material_items ?? [])
      .map((item) => item.description.trim())
      .filter(Boolean),
    worker_names: entry.worker_rows
      .map((row) => row.worker_name.trim())
      .filter(Boolean),
    estimated_hours: entry.estimated_hours ?? null,
  };
}

export function getExtraWorkOverviewDescription(ticket: MobileExtraWorkTicket): string | null {
  const primaryEntry = getExtraWorkOverviewPrimaryEntry(ticket);
  return firstMeaningfulText(
    ticket.work_description,
    primaryEntry?.remarks,
    ticket.notes,
  );
}

export function filterExtraWorkOverviewTickets(
  tickets: MobileExtraWorkTicket[],
  site: Site,
  query: string,
): MobileExtraWorkTicket[] {
  const normalizedQuery = normalizeExtraWorkOverviewSearch(query);
  if (!normalizedQuery) {
    return tickets;
  }
  return tickets.filter((ticket) => (
    buildExtraWorkOverviewSearchText(ticket, site).includes(normalizedQuery)
  ));
}

export function buildExtraWorkOverviewSearchText(
  ticket: MobileExtraWorkTicket,
  site: Site,
): string {
  const entryValues = (ticket.entry_summaries ?? []).flatMap((entry) => [
    entry.component,
    entry.floor,
    entry.room_number,
    entry.axis,
    entry.remarks,
    entry.material_text,
    ...entry.material_descriptions,
    ...entry.worker_names,
  ]);
  return normalizeExtraWorkOverviewSearch([
    ticket.display_number,
    ticket.sequence_number,
    ticket.title,
    ticket.created_by_name,
    ticket.customer_name,
    ticket.ordered_by_name,
    ticket.ordered_by_company,
    ticket.notes,
    ticket.work_description,
    ticket.executor_other_name,
    ticket.worker_signature_name,
    ticket.customer_signature_name,
    ticket.total_hours,
    ticket.estimated_order_value,
    site.site_number,
    site.name,
    site.customer,
    ...entryValues,
  ].filter((value) => value !== null && value !== undefined).join(" "));
}

export function normalizeExtraWorkOverviewSearch(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase("de-DE")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/ß/g, "ss")
    .replace(/ae/g, "a")
    .replace(/oe/g, "o")
    .replace(/ue/g, "u")
    .replace(/\s+/g, " ");
}

export function resolveExtraWorkOverviewPeriod(
  ticket: MobileExtraWorkTicket,
): { start: string; end: string } | null {
  if (ticket.manual_execution_start && ticket.manual_execution_end) {
    return {
      start: ticket.manual_execution_start,
      end: ticket.manual_execution_end,
    };
  }
  if (ticket.manual_execution_week && ticket.manual_execution_week_year) {
    return isoWeekRange(ticket.manual_execution_week_year, ticket.manual_execution_week);
  }
  const createdDate = ticket.created_at.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(createdDate)) {
    return null;
  }
  const created = new Date(`${createdDate}T00:00:00Z`);
  if (Number.isNaN(created.getTime())) {
    return null;
  }
  const weekday = created.getUTCDay() || 7;
  created.setUTCDate(created.getUTCDate() - weekday + 1);
  const end = new Date(created);
  end.setUTCDate(end.getUTCDate() + 6);
  return { start: toDateKey(created), end: toDateKey(end) };
}

function isoWeekRange(year: number, week: number): { start: string; end: string } | null {
  if (!Number.isInteger(year) || !Number.isInteger(week) || week < 1 || week > 53) {
    return null;
  }
  const januaryFourth = new Date(Date.UTC(year, 0, 4));
  const januaryFourthWeekday = januaryFourth.getUTCDay() || 7;
  const start = new Date(januaryFourth);
  start.setUTCDate(januaryFourth.getUTCDate() - januaryFourthWeekday + 1 + (week - 1) * 7);
  if (start.getUTCFullYear() > year + 1 || start.getUTCFullYear() < year - 1) {
    return null;
  }
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  return { start: toDateKey(start), end: toDateKey(end) };
}

function toDateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function firstMeaningfulText(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const cleaned = value?.trim();
    if (cleaned) {
      return cleaned;
    }
  }
  return null;
}
