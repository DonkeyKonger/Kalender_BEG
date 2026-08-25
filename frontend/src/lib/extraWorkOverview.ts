import type {
  ExtraWorkTicketEntrySummary,
  MobileExtraWorkTicket,
  MobileExtraWorkTicketEntry,
  Site,
} from "../types/site";

export const EXTRA_WORK_OVERVIEW_DEFAULT_PAGE_SIZE = 8;
export const EXTRA_WORK_OVERVIEW_MIN_PAGE_SIZE = 4;
export const EXTRA_WORK_OVERVIEW_MAX_PAGE_SIZE = 10;
export const EXTRA_WORK_OVERVIEW_ROW_HEIGHT = 66;
export const EXTRA_WORK_OVERVIEW_HEADER_HEIGHT = 42;
export const EXTRA_WORK_OVERVIEW_PAGINATION_HEIGHT = 48;
export const EXTRA_WORK_OVERVIEW_CONTAINER_BORDER = 2;

export function compareExtraWorkTicketsOldestFirst(
  left: MobileExtraWorkTicket,
  right: MobileExtraWorkTicket,
): number {
  const leftCreatedAt = parseExtraWorkCreatedAt(left.created_at);
  const rightCreatedAt = parseExtraWorkCreatedAt(right.created_at);
  if (leftCreatedAt !== null && rightCreatedAt !== null && leftCreatedAt !== rightCreatedAt) {
    return leftCreatedAt - rightCreatedAt;
  }
  if (leftCreatedAt === null && rightCreatedAt !== null) {
    return 1;
  }
  if (leftCreatedAt !== null && rightCreatedAt === null) {
    return -1;
  }
  if (left.sequence_number !== right.sequence_number) {
    return left.sequence_number - right.sequence_number;
  }
  return left.id - right.id;
}

export function calculateExtraWorkOverviewPageSize(availableHeight: number): number {
  const rowAreaHeight = Math.max(
    0,
    availableHeight
      - EXTRA_WORK_OVERVIEW_HEADER_HEIGHT
      - EXTRA_WORK_OVERVIEW_PAGINATION_HEIGHT
      - EXTRA_WORK_OVERVIEW_CONTAINER_BORDER,
  );
  const measuredRows = Math.floor(rowAreaHeight / EXTRA_WORK_OVERVIEW_ROW_HEIGHT);
  return Math.min(
    EXTRA_WORK_OVERVIEW_MAX_PAGE_SIZE,
    Math.max(EXTRA_WORK_OVERVIEW_MIN_PAGE_SIZE, measuredRows),
  );
}

export function getExtraWorkOverviewMasterHeight(pageSize: number): number {
  const boundedPageSize = Math.min(
    EXTRA_WORK_OVERVIEW_MAX_PAGE_SIZE,
    Math.max(EXTRA_WORK_OVERVIEW_MIN_PAGE_SIZE, Math.floor(pageSize)),
  );
  return EXTRA_WORK_OVERVIEW_HEADER_HEIGHT
    + EXTRA_WORK_OVERVIEW_PAGINATION_HEIGHT
    + EXTRA_WORK_OVERVIEW_CONTAINER_BORDER
    + boundedPageSize * EXTRA_WORK_OVERVIEW_ROW_HEIGHT;
}

export function getExtraWorkOverviewScrollbarWidth({
  clientHeight,
  clientWidth,
  offsetWidth,
  scrollHeight,
}: {
  clientHeight: number;
  clientWidth: number;
  offsetWidth: number;
  scrollHeight: number;
}): number {
  if (scrollHeight <= clientHeight + 1) {
    return 0;
  }
  return Math.max(0, offsetWidth - clientWidth);
}

export function getExtraWorkOverviewPageForIndex(index: number, pageSize: number): number {
  if (!Number.isInteger(index) || index < 0 || !Number.isInteger(pageSize) || pageSize < 1) {
    return 1;
  }
  return Math.floor(index / pageSize) + 1;
}

export function getExtraWorkOverviewPageWindow(
  itemCount: number,
  requestedPage: number,
  pageSize: number,
): { end: number; page: number; pageCount: number; start: number } {
  const safeItemCount = Math.max(0, Math.floor(itemCount));
  const safePageSize = Math.max(1, Math.floor(pageSize));
  const pageCount = Math.max(1, Math.ceil(safeItemCount / safePageSize));
  const page = Math.min(pageCount, Math.max(1, Math.floor(requestedPage)));
  const start = (page - 1) * safePageSize;
  return {
    end: Math.min(safeItemCount, start + safePageSize),
    page,
    pageCount,
    start,
  };
}

export type ExtraWorkOverviewPageItem = number | "ellipsis-left" | "ellipsis-right";

export function getExtraWorkOverviewPageItems(
  pageCount: number,
  currentPage: number,
): ExtraWorkOverviewPageItem[] {
  const safePageCount = Math.max(1, Math.floor(pageCount));
  const safeCurrentPage = Math.min(safePageCount, Math.max(1, Math.floor(currentPage)));
  if (safePageCount <= 7) {
    return Array.from({ length: safePageCount }, (_, index) => index + 1);
  }
  if (safeCurrentPage <= 4) {
    return [1, 2, 3, 4, 5, "ellipsis-right", safePageCount];
  }
  if (safeCurrentPage >= safePageCount - 3) {
    return [
      1,
      "ellipsis-left",
      safePageCount - 4,
      safePageCount - 3,
      safePageCount - 2,
      safePageCount - 1,
      safePageCount,
    ];
  }
  return [
    1,
    "ellipsis-left",
    safeCurrentPage - 1,
    safeCurrentPage,
    safeCurrentPage + 1,
    "ellipsis-right",
    safePageCount,
  ];
}

export function formatExtraWorkOverviewTitle(ticket: MobileExtraWorkTicket): string {
  return `Zusatzauftrag ${ticket.display_number}`;
}

export function formatExtraWorkOverviewCreatorName(
  value: string | null | undefined,
): { accessibleName: string; fullName: string; shortName: string } {
  const fullName = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!fullName) {
    return {
      accessibleName: "Ersteller nicht angegeben",
      fullName: "",
      shortName: "–",
    };
  }
  const [firstNamePart, ...remainingNameParts] = fullName.split(" ");
  if (remainingNameParts.length === 0) {
    return { accessibleName: fullName, fullName, shortName: fullName };
  }
  const initial = Array.from(firstNamePart)[0] ?? firstNamePart;
  return {
    accessibleName: fullName,
    fullName,
    shortName: `${initial}. ${remainingNameParts.join(" ")}`,
  };
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

function parseExtraWorkCreatedAt(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
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

export function formatExtraWorkOverviewIsoWeek(ticket: MobileExtraWorkTicket): string {
  const period = resolveExtraWorkOverviewPeriod(ticket);
  if (!period) {
    return "–";
  }
  const week = getIsoWeekFromDateKey(period.start);
  return week === null ? "–" : `KW ${week}`;
}

function getIsoWeekFromDateKey(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || toDateKey(date) !== value) {
    return null;
  }
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const isoYear = date.getUTCFullYear();
  const isoYearStart = new Date(Date.UTC(isoYear, 0, 1));
  return Math.ceil(((date.getTime() - isoYearStart.getTime()) / 86_400_000 + 1) / 7);
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
