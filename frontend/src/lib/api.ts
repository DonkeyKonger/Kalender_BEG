import type { Absence, AbsenceCreate, AbsenceUpdate, VacationCarryover, VacationCarryoverUpdate } from "../types/absence";
import type { CurrentUser, LoginResponse } from "../types/auth";
import type { Customer, CustomerCreate, CustomerRemoveResponse, CustomerUpdate } from "../types/customer";
import type { MicrosoftGraphBackfillProjectFoldersResponse, MicrosoftGraphConnectionTestResponse, MicrosoftGraphCreateTestFolderResponse } from "../types/admin";
import type { AdminUser, AdminUserCreate, AdminUserUpdate } from "../types/user";
import type { AssignmentRead, AssignmentType, MatrixCell, MatrixCellMark, MatrixConflictMessage, MatrixEntryInput, MatrixMutationResponse, MatrixResponse, MatrixSite, MatrixVersionResponse } from "../types/matrix";
import type { GpsLocationPointCreate, GpsLocationPointRead, GpsRecentLocationPoint } from "../types/gps";
import type { Person, PersonCreate, PersonGeocodeSearchResult, PersonHoursAccount, PersonHoursManualAdjustmentPayload, PersonHoursPayoutPayload, PersonMapResponse, PersonRemovePlan, PersonRemoveResponse, PersonUpdate } from "../types/person";
import type { CustomerSignaturePayload, ExtraWorkCustomerSignaturePayload, ExtraWorkTicketEmailSendResponse, MeasurementAreaRow, MeasurementAreaRowPayload, MeasurementBase, MeasurementBaseUpdate, MeasurementDashboardSubmission, MeasurementEntry, MeasurementEntryPayload, MeasurementImportOptions, MeasurementImportResponse, MeasurementItem, MeasurementItemUpdatePayload, MeasurementTimeAnalysis, MeasurementTimesheet, MobileExtraWorkTicket, MobileExtraWorkTicketEntry, MobileExtraWorkTicketEntryPayload, MobileExtraWorkTicketPhoto, MobileMeasurementBatch, MobileMeasurementBatchPhoto, MobileMeasurementFreeItemPayload, MobileMeasurementItem, ProjectFolder, ProjectFolderDocumentItem, ProjectFolderDocumentList, Site, SiteCreate, SiteEmailRecipientsResponse, SiteEmailRecipientsUpdate, SiteGeocodeSearchResult, SiteMapResponse, SiteRemovePlan, SiteRemoveResponse, SiteSummary, SiteUpdate, WorkerSignaturePayload } from "../types/site";
import type { MobileAssignment, MobileAssignmentsResponse, MobileSite } from "../types/mobile";
import type { TimeEntry, TimeEntryCorrection, TimeEntryCreate, TimeEntryPayrollCorrection, TimeEntryPayrollDateCorrection, TimeEntryReviewDecisionPayload, TimeEntryUpdate, TimeEntryWeeklyReview } from "../types/timeEntry";
import type { ToolMaterialItem, ToolMaterialItemCreate, ToolMaterialItemUpdate } from "../types/toolMaterial";
import type { WeatherSummary } from "../types/weather";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000/api";
const AUTH_REFRESH_PATH = "/auth/refresh";
let refreshAccessTokenPromise: Promise<string | null> | null = null;

export function getApiBaseUrl(): string {
  return API_BASE_URL;
}

export function getAccessToken(): string | null {
  return localStorage.getItem("kb_access_token");
}

type AssignmentMutationApiResponse = {
  assignment: { id: number };
  warnings: MatrixConflictMessage[];
  infos: MatrixConflictMessage[];
  updated_site_cells?: Array<{ site_id: number; cells: MatrixCell[] }>;
};

type AssignmentPayload = {
  site_id?: number;
  person_id?: number;
  start_date?: string;
  end_date?: string;
  assignment_type?: AssignmentType;
  note?: string | null;
};

type AssignmentSegmentMovePayload = {
  segment_start_date: string;
  segment_end_date: string;
  target_site_id: number;
  target_start_date: string;
};

export type VehicleLatestPositionItem = {
  vehicle: {
    id: number;
    source: string;
    external_id: string;
    ctrack_node_id: number | null;
    label: string | null;
    vehicle_registration: string | null;
    fleet_number: string | null;
    description: string | null;
    is_active: boolean;
    created_at: string | null;
    updated_at: string | null;
  };
  position: {
    id: number;
    vehicle_asset_id: number;
    source: string;
    event_time_utc: string | null;
    latitude: number;
    longitude: number;
    speed: number | null;
    ignition: boolean | null;
    odometer: number | null;
    driver_id: string | null;
    driver_name: string | null;
    location_text: string | null;
    updated_at: string | null;
  };
};

export type DashboardMessagesSummary = {
  open_count: number;
  latest_messages: MeasurementDashboardSubmission[];
};

export type DashboardNote = {
  id: number;
  text: string;
  due_date: string | null;
  completed: boolean;
  completed_at: string | null;
  site_id: number | null;
  employee_id: number | null;
  created_by_user_id: number;
  site: {
    id: number;
    site_number: string | null;
    name: string;
  } | null;
  employee: {
    id: number;
    display_name: string;
    short_code: string;
  } | null;
  created_at: string;
  updated_at: string;
};

export type DashboardNotePayload = {
  text: string;
  due_date?: string | null;
  site_id?: number | null;
  employee_id?: number | null;
};

export type DashboardNoteUpdatePayload = Partial<DashboardNotePayload> & {
  completed?: boolean;
};

export type DashboardOverviewAssignedSite = {
  site: MatrixSite;
  managerLabel: string;
  internalCount: number;
  externalCount: number;
  hasWarnings: boolean;
};

export type DashboardOverviewStaffingNeed = {
  date: string;
  siteName: string;
  siteNumber: string | null;
  managerLabel: string;
};

export type DashboardOverviewConflict = {
  key: string;
  title: string;
  detail: string;
  severity: "hard" | "warning";
  date: string;
};

export type DashboardOverviewPerson = {
  id: number;
  first_name: string;
  last_name: string;
  display_name: string;
  short_code: string;
  detail?: string;
};

export type DashboardOverview = {
  todayAssignedSites: DashboardOverviewAssignedSite[];
  todayAssignedSiteGroups: Array<{
    manager: {
      key: string;
      label: string;
      name: string;
    };
    sites: DashboardOverviewAssignedSite[];
  }>;
  workerSummaryGroups: Array<{
    kind: "assigned" | "free";
    manager: {
      key: string;
      label: string;
      name: string;
    };
    people: DashboardOverviewPerson[];
  }>;
  totalWorkerSummaryPeople: number;
  freeWorkerGroups: Array<{
    manager: {
      key: string;
      label: string;
      name: string;
    };
    people: DashboardOverviewPerson[];
  }>;
  totalFreeWorkers: number;
  openStaffingNeeds: DashboardOverviewStaffingNeed[];
  conflicts: DashboardOverviewConflict[];
  tomorrowAssignedCount: number;
  tomorrowOpenNeeds: DashboardOverviewStaffingNeed[];
  tomorrowConflicts: DashboardOverviewConflict[];
  currentWeekNeeds: DashboardOverviewStaffingNeed[];
  nextWeekNeeds: DashboardOverviewStaffingNeed[];
  workerLookup: Array<{
    person: DashboardOverviewPerson;
    status: string;
    detail: string;
    managerLabel: string;
  }>;
};

export class ApiError extends Error {
  status: number;
  detail: unknown;

  constructor(status: number, detail: unknown) {
    super(formatApiErrorDetail(detail));
    this.status = status;
    this.detail = detail;
  }
}

function formatApiErrorDetail(detail: unknown): string {
  if (typeof detail === "string") {
    return detail;
  }
  if (Array.isArray(detail)) {
    return detail.map(formatApiErrorDetail).filter(Boolean).join(" ") || "API-Anfrage fehlgeschlagen.";
  }
  if (isRecord(detail)) {
    if (typeof detail.msg === "string") {
      return detail.msg;
    }
    if (typeof detail.message === "string") {
      return detail.message;
    }
    if (typeof detail.detail === "string") {
      return detail.detail;
    }
    try {
      return JSON.stringify(detail);
    } catch {
      return "API-Anfrage fehlgeschlagen.";
    }
  }
  return "API-Anfrage fehlgeschlagen.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function requestBlob(path: string): Promise<Blob> {
  const token = localStorage.getItem("kb_access_token");
  const headers = new Headers();
  headers.set("Accept", "*/*");
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(`${API_BASE_URL}${path}`, { headers });
  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    const payload = contentType.includes("application/json")
      ? await response.json()
      : await response.text();
    const detail = payload.detail ?? payload;
    console.error("API blob request failed", {
      method: "GET",
      url: `${API_BASE_URL}${path}`,
      status: response.status,
      responseBody: payload,
    });
    throw new ApiError(response.status, detail);
  }
  return response.blob();
}

async function request<T>(path: string, options: RequestInit = {}, retryOnUnauthorized = true): Promise<T> {
  const { response, payload } = await sendRequest(path, options);

  if (
    response.status === 401
    && retryOnUnauthorized
    && path !== AUTH_REFRESH_PATH
    && getAccessToken()
  ) {
    const refreshedToken = await refreshAccessToken();
    if (refreshedToken) {
      return request<T>(path, options, false);
    }
  }

  if (response.status === 204) {
    return undefined as T;
  }

  if (!response.ok) {
    const detail = getApiErrorDetail(payload);
    console.error("API request failed", {
      method: options.method ?? "GET",
      url: `${API_BASE_URL}${path}`,
      requestBody: options.body,
      status: response.status,
      responseBody: payload,
    });
    throw new ApiError(response.status, detail);
  }

  return payload as T;
}

async function sendRequest(path: string, options: RequestInit = {}): Promise<{ response: Response; payload: unknown }> {
  const token = localStorage.getItem("kb_access_token");
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  const isFormData = typeof FormData !== "undefined" && options.body instanceof FormData;
  if (options.body && !isFormData && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
  });

  if (response.status === 204) {
    return { response, payload: undefined };
  }

  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  return { response, payload };
}

function getApiErrorDetail(payload: unknown): unknown {
  if (isRecord(payload) && "detail" in payload) {
    return payload.detail;
  }
  return payload;
}

async function refreshAccessToken(): Promise<string | null> {
  if (!getAccessToken()) {
    return null;
  }
  refreshAccessTokenPromise ??= request<LoginResponse>(
    AUTH_REFRESH_PATH,
    { method: "POST" },
    false,
  )
    .then((token) => {
      localStorage.setItem("kb_access_token", token.access_token);
      return token.access_token;
    })
    .catch((error) => {
      console.warn("Session refresh failed", error);
      return null;
    })
    .finally(() => {
      refreshAccessTokenPromise = null;
    });
  return refreshAccessTokenPromise;
}

export const api = {
  async login(username: string, password: string): Promise<LoginResponse> {
    return request<LoginResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
  },

  async me(): Promise<CurrentUser> {
    return request<CurrentUser>("/auth/me");
  },

  async changePassword(newPassword: string): Promise<CurrentUser> {
    return request<CurrentUser>("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ new_password: newPassword }),
    });
  },

  async logout(): Promise<void> {
    return request<void>("/auth/logout", { method: "POST" }, false);
  },

  async registerPushDevice(payload: {
    platform: string;
    token: string;
    device_id?: string | null;
  }): Promise<{ id: number; platform: string; is_active: boolean; last_seen_at: string | null }> {
    return request<{ id: number; platform: string; is_active: boolean; last_seen_at: string | null }>(
      "/me/push-devices/register",
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );
  },

  async createGpsLocationPoint(payload: GpsLocationPointCreate): Promise<GpsLocationPointRead> {
    return request<GpsLocationPointRead>("/gps/location-points", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async recentGpsLocationPoints(params: { limit?: number } = {}): Promise<GpsRecentLocationPoint[]> {
    const search = new URLSearchParams();
    if (params.limit !== undefined) {
      search.set("limit", String(params.limit));
    }
    const suffix = search.toString() ? `?${search.toString()}` : "";
    return request<GpsRecentLocationPoint[]>(`/gps/location-points/recent${suffix}`);
  },

  async dashboardWeather(): Promise<WeatherSummary> {
    return request<WeatherSummary>("/dashboard/weather");
  },

  async dashboardOverview(params: {
    historyStart: string;
    today: string;
    tomorrow: string;
    weekEnd: string;
    nextWeekStart: string;
    nextWeekEnd: string;
  }): Promise<DashboardOverview> {
    const search = new URLSearchParams({
      history_start: params.historyStart,
      today: params.today,
      tomorrow: params.tomorrow,
      week_end: params.weekEnd,
      next_week_start: params.nextWeekStart,
      next_week_end: params.nextWeekEnd,
    });
    return request<DashboardOverview>(`/dashboard/overview?${search.toString()}`);
  },

  async dashboardMeasurementSubmissions(params: { limit?: number } = {}): Promise<MeasurementDashboardSubmission[]> {
    const search = new URLSearchParams();
    if (params.limit !== undefined) {
      search.set("limit", String(params.limit));
    }
    const suffix = search.toString() ? `?${search.toString()}` : "";
    return request<MeasurementDashboardSubmission[]>(`/dashboard/measurement-submissions${suffix}`);
  },

  async dashboardMessagesSummary(params: { limit?: number } = {}): Promise<DashboardMessagesSummary> {
    const search = new URLSearchParams();
    if (params.limit !== undefined) {
      search.set("limit", String(params.limit));
    }
    const suffix = search.toString() ? `?${search.toString()}` : "";
    return request<DashboardMessagesSummary>(`/dashboard/messages/summary${suffix}`);
  },

  async dismissDashboardMessage(messageKey: string): Promise<void> {
    await request<void>(`/dashboard/messages/${encodeURIComponent(messageKey)}/dismiss`, {
      method: "POST",
    });
  },

  async dashboardNotes(params: { completed?: boolean | null } = {}): Promise<DashboardNote[]> {
    const search = new URLSearchParams();
    if (params.completed !== null && params.completed !== undefined) {
      search.set("completed", String(params.completed));
    }
    const suffix = search.toString() ? `?${search.toString()}` : "";
    return request<DashboardNote[]>(`/dashboard/notes${suffix}`);
  },

  async dashboardNoteSiteOptions(): Promise<SiteSummary[]> {
    return request<SiteSummary[]>("/dashboard/notes/site-options");
  },

  async createDashboardNote(payload: DashboardNotePayload): Promise<DashboardNote> {
    return request<DashboardNote>("/dashboard/notes", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async updateDashboardNote(noteId: number, payload: DashboardNoteUpdatePayload): Promise<DashboardNote> {
    return request<DashboardNote>(`/dashboard/notes/${noteId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  },

  async deleteDashboardNote(noteId: number): Promise<void> {
    await request<void>(`/dashboard/notes/${noteId}`, { method: "DELETE" });
  },

  async persons(params: { isActive?: boolean | null } = { isActive: true }): Promise<Person[]> {
    const search = new URLSearchParams();
    if (params.isActive !== null && params.isActive !== undefined) {
      search.set("is_active", String(params.isActive));
    }
    const suffix = search.toString() ? `?${search.toString()}` : "";
    const people = await request<Person[]>(`/persons${suffix}`);
    return people.filter((person) => person.deleted_at === null);
  },

  async personMap(): Promise<PersonMapResponse> {
    return request<PersonMapResponse>("/persons/map");
  },

  async vehicleLatestPositions(): Promise<VehicleLatestPositionItem[]> {
    return request<VehicleLatestPositionItem[]>("/vehicles/latest-positions");
  },

  async toolMaterialItems(params: { search?: string } = {}): Promise<ToolMaterialItem[]> {
    const search = new URLSearchParams();
    const cleanedSearch = params.search?.trim();
    if (cleanedSearch) {
      search.set("search", cleanedSearch);
    }
    const suffix = search.toString() ? `?${search.toString()}` : "";
    return request<ToolMaterialItem[]>(`/admin/tool-material-items${suffix}`);
  },

  async createToolMaterialItem(payload: ToolMaterialItemCreate): Promise<ToolMaterialItem> {
    return request<ToolMaterialItem>("/admin/tool-material-items", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async updateToolMaterialItem(itemId: number, payload: ToolMaterialItemUpdate): Promise<ToolMaterialItem> {
    return request<ToolMaterialItem>(`/admin/tool-material-items/${itemId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  },

  async deleteToolMaterialItem(itemId: number): Promise<void> {
    await request<void>(`/admin/tool-material-items/${itemId}`, { method: "DELETE" });
  },

  async searchPersonAddress(query: string): Promise<PersonGeocodeSearchResult[]> {
    const search = new URLSearchParams({ q: query, limit: "5" });
    return request<PersonGeocodeSearchResult[]>(`/persons/geocode/search?${search.toString()}`);
  },

  async users(): Promise<AdminUser[]> {
    return request<AdminUser[]>("/users");
  },

  async testMicrosoftGraphConnection(): Promise<MicrosoftGraphConnectionTestResponse> {
    return request<MicrosoftGraphConnectionTestResponse>("/admin/integrations/microsoft-graph/test");
  },

  async createMicrosoftGraphTestProjectFolder(): Promise<MicrosoftGraphCreateTestFolderResponse> {
    return request<MicrosoftGraphCreateTestFolderResponse>(
      "/admin/integrations/microsoft-graph/create-test-project-folder",
      { method: "POST" },
    );
  },

  async backfillMicrosoftGraphProjectFolders(limit = 10): Promise<MicrosoftGraphBackfillProjectFoldersResponse> {
    const search = new URLSearchParams({ limit: String(limit) });
    return request<MicrosoftGraphBackfillProjectFoldersResponse>(
      `/admin/integrations/microsoft-graph/backfill-project-folders?${search.toString()}`,
      { method: "POST" },
    );
  },

  async createPerson(payload: PersonCreate): Promise<Person> {
    return request<Person>("/persons", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async createExternalPerson(displayName: string): Promise<Person> {
    return request<Person>("/persons/external", {
      method: "POST",
      body: JSON.stringify({ display_name: displayName }),
    });
  },

  async updatePerson(personId: number, payload: PersonUpdate): Promise<Person> {
    return request<Person>(`/persons/${personId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  },

  async personHoursAccount(personId: number): Promise<PersonHoursAccount> {
    return request<PersonHoursAccount>(`/persons/${personId}/hours-account`);
  },

  async createPersonHoursManualAdjustment(personId: number, payload: PersonHoursManualAdjustmentPayload): Promise<PersonHoursAccount> {
    return request<PersonHoursAccount>(`/persons/${personId}/hours-account/manual-adjustment`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async createPersonHoursPayout(personId: number, payload: PersonHoursPayoutPayload): Promise<PersonHoursAccount> {
    return request<PersonHoursAccount>(`/persons/${personId}/hours-account/payout`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async personRemovalPlan(personId: number): Promise<PersonRemovePlan> {
    return request<PersonRemovePlan>(`/persons/${personId}/removal-plan`);
  },

  async removePerson(personId: number): Promise<PersonRemoveResponse> {
    return request<PersonRemoveResponse>(`/persons/${personId}/remove`, { method: "POST" });
  },

  async deletePerson(personId: number): Promise<void> {
    return request<void>(`/persons/${personId}`, { method: "DELETE" });
  },

  async customers(params: { isActive?: boolean | null } = { isActive: true }): Promise<Customer[]> {
    const search = new URLSearchParams();
    if (params.isActive !== null && params.isActive !== undefined) {
      search.set("is_active", String(params.isActive));
    }
    const suffix = search.toString() ? `?${search.toString()}` : "";
    return request<Customer[]>(`/customers${suffix}`);
  },

  async createCustomer(payload: CustomerCreate): Promise<Customer> {
    return request<Customer>("/customers", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async updateCustomer(customerId: number, payload: CustomerUpdate): Promise<Customer> {
    return request<Customer>(`/customers/${customerId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  },

  async removeCustomer(customerId: number): Promise<CustomerRemoveResponse> {
    return request<CustomerRemoveResponse>(`/customers/${customerId}/remove`, { method: "POST" });
  },

  async createUser(payload: AdminUserCreate): Promise<AdminUser> {
    return request<AdminUser>("/users", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async updateUser(userId: number, payload: AdminUserUpdate): Promise<AdminUser> {
    return request<AdminUser>(`/users/${userId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  },

  async resetUserPassword(userId: number, password: string): Promise<AdminUser> {
    return request<AdminUser>(`/users/${userId}/reset-password`, {
      method: "POST",
      body: JSON.stringify({ password }),
    });
  },

  async disableUser(userId: number): Promise<AdminUser> {
    return request<AdminUser>(`/users/${userId}/disable`, { method: "POST" });
  },

  async deleteUser(userId: number): Promise<void> {
    return request<void>(`/users/${userId}`, { method: "DELETE" });
  },

  async timeEntries(params: {
    personId?: number;
    siteId?: number;
    dateFrom?: string;
    dateTo?: string;
    includeGpsStatus?: boolean;
    reviewOpenOnly?: boolean;
    projectMountingOnly?: boolean;
  } = {}): Promise<TimeEntry[]> {
    const search = new URLSearchParams();
    if (params.personId !== undefined) {
      search.set("person_id", String(params.personId));
    }
    if (params.siteId !== undefined) {
      search.set("site_id", String(params.siteId));
    }
    if (params.dateFrom) {
      search.set("date_from", params.dateFrom);
    }
    if (params.dateTo) {
      search.set("date_to", params.dateTo);
    }
    if (params.includeGpsStatus) {
      search.set("include_gps_status", "true");
    }
    if (params.reviewOpenOnly) {
      search.set("review_open_only", "true");
    }
    if (params.projectMountingOnly) {
      search.set("project_mounting_only", "true");
    }
    const suffix = search.toString() ? `?${search.toString()}` : "";
    return request<TimeEntry[]>(`/time-entries${suffix}`);
  },

  async createTimeEntry(payload: TimeEntryCreate): Promise<TimeEntry> {
    return request<TimeEntry>("/time-entries", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async updateTimeEntry(entryId: number, payload: TimeEntryUpdate): Promise<TimeEntry> {
    return request<TimeEntry>(`/time-entries/${entryId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  },

  async deleteTimeEntry(entryId: number): Promise<void> {
    await request<void>(`/time-entries/${entryId}`, { method: "DELETE" });
  },

  async approveTimeEntryReview(entryId: number): Promise<TimeEntry> {
    return request<TimeEntry>(`/time-entries/${entryId}/review/approve`, { method: "POST" });
  },

  async correctTimeEntryReview(entryId: number, payload: TimeEntryCorrection): Promise<TimeEntry> {
    return request<TimeEntry>(`/time-entries/${entryId}/review/correct`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async decideTimeEntryReview(entryId: number, payload: TimeEntryReviewDecisionPayload): Promise<TimeEntry> {
    return request<TimeEntry>(`/time-entries/${entryId}/review/decision`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async setTimeEntryPayrollReview(entryId: number, reviewed: boolean): Promise<TimeEntry> {
    return request<TimeEntry>(`/time-entries/${entryId}/payroll-review`, {
      method: "POST",
      body: JSON.stringify({ reviewed }),
    });
  },

  async setTimeEntryPayrollCorrection(entryId: number, payload: TimeEntryPayrollCorrection): Promise<TimeEntry> {
    return request<TimeEntry>(`/time-entries/${entryId}/payroll-correction`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async setTimeEntryPayrollDateCorrection(entryId: number, payload: TimeEntryPayrollDateCorrection): Promise<TimeEntry> {
    return request<TimeEntry>(`/time-entries/${entryId}/payroll-date-correction`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async timeEntryWeeklyReviews(params: { isoYear: number; isoWeek?: number }): Promise<TimeEntryWeeklyReview[]> {
    const search = new URLSearchParams({
      iso_year: String(params.isoYear),
    });
    if (params.isoWeek !== undefined) {
      search.set("iso_week", String(params.isoWeek));
    }
    return request<TimeEntryWeeklyReview[]>(`/time-entries/weekly-reviews?${search.toString()}`);
  },

  async myTimeEntryWeeklyReviews(params: { isoYear: number; isoWeek?: number }): Promise<TimeEntryWeeklyReview[]> {
    const search = new URLSearchParams({
      iso_year: String(params.isoYear),
    });
    if (params.isoWeek !== undefined) {
      search.set("iso_week", String(params.isoWeek));
    }
    return request<TimeEntryWeeklyReview[]>(`/me/time-entry-weekly-reviews?${search.toString()}`);
  },

  async markTimeEntryWeeklyReview(payload: { personId: number; isoYear: number; isoWeek: number }): Promise<TimeEntryWeeklyReview> {
    return request<TimeEntryWeeklyReview>("/time-entries/weekly-reviews", {
      method: "POST",
      body: JSON.stringify({
        person_id: payload.personId,
        iso_year: payload.isoYear,
        iso_week: payload.isoWeek,
      }),
    });
  },

  async resetTimeEntryWeeklyReview(payload: { personId: number; isoYear: number; isoWeek: number }): Promise<TimeEntryWeeklyReview> {
    return request<TimeEntryWeeklyReview>("/time-entries/weekly-reviews/reset", {
      method: "POST",
      body: JSON.stringify({
        person_id: payload.personId,
        iso_year: payload.isoYear,
        iso_week: payload.isoWeek,
      }),
    });
  },


  async siteSummaries(params: { includeClosed?: boolean } = {}): Promise<SiteSummary[]> {
    const search = new URLSearchParams();
    if (params.includeClosed) {
      search.set("include_closed", "true");
    }
    const suffix = search.toString() ? `?${search.toString()}` : "";
    return request<SiteSummary[]>(`/sites/summary${suffix}`);
  },

  async sites(params: { includeClosed?: boolean } = {}): Promise<Site[]> {
    const search = new URLSearchParams();
    if (params.includeClosed) {
      search.set("include_closed", "true");
    }
    const suffix = search.toString() ? `?${search.toString()}` : "";
    return request<Site[]>(`/sites${suffix}`);
  },

  async siteProjectManagers(): Promise<Person[]> {
    return request<Person[]>("/sites/project-managers");
  },

  async siteMap(): Promise<SiteMapResponse> {
    return request<SiteMapResponse>("/sites/map");
  },

  async searchSiteAddress(query: string): Promise<SiteGeocodeSearchResult[]> {
    const search = new URLSearchParams({ q: query, limit: "5" });
    return request<SiteGeocodeSearchResult[]>(`/sites/geocode/search?${search.toString()}`);
  },

  async site(siteId: number): Promise<Site> {
    return request<Site>(`/sites/${siteId}`);
  },

  async createSite(payload: SiteCreate): Promise<Site> {
    return request<Site>("/sites", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async updateSite(siteId: number, payload: SiteUpdate): Promise<Site> {
    return request<Site>(`/sites/${siteId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  },

  async closeSite(siteId: number): Promise<Site> {
    return request<Site>(`/sites/${siteId}/close`, { method: "POST" });
  },

  async reactivateSite(siteId: number): Promise<Site> {
    return request<Site>(`/sites/${siteId}/reactivate`, { method: "POST" });
  },

  async checkSiteLocation(siteId: number): Promise<Site> {
    return request<Site>(`/sites/${siteId}/check-location`, { method: "POST" });
  },

  async siteRemovalPlan(siteId: number): Promise<SiteRemovePlan> {
    return request<SiteRemovePlan>(`/sites/${siteId}/removal-plan`);
  },

  async projectFolders(siteId: number): Promise<ProjectFolder[]> {
    return request<ProjectFolder[]>(`/sites/${siteId}/project-folders`);
  },

  async projectFolderDocuments(siteId: number, folderKey: string): Promise<ProjectFolderDocumentList> {
    return request<ProjectFolderDocumentList>(
      `/sites/${siteId}/documents/folders/${encodeURIComponent(folderKey)}/children`,
    );
  },

  async projectFolderItemChildren(
    siteId: number,
    folderKey: string,
    itemId: string,
  ): Promise<ProjectFolderDocumentList> {
    const encodedSiteId = encodeURIComponent(String(siteId));
    const encodedFolderKey = encodeURIComponent(folderKey);
    const encodedItemId = encodeURIComponent(itemId);
    return request<ProjectFolderDocumentList>(
      `/sites/${encodedSiteId}/documents/folders/${encodedFolderKey}/items/${encodedItemId}/children`,
    );
  },

  async downloadProjectFolderDocument(
    siteId: number,
    folderKey: string,
    itemId: string,
  ): Promise<Blob> {
    return requestBlob(
      `/sites/${siteId}/documents/folders/${encodeURIComponent(folderKey)}/items/${encodeURIComponent(itemId)}/download`,
    );
  },

  async projectFolderDocumentContent(
    siteId: number,
    folderKey: string,
    itemId: string,
    disposition: "inline" | "attachment" = "inline",
  ): Promise<Blob> {
    const encodedSiteId = encodeURIComponent(String(siteId));
    const encodedFolderKey = encodeURIComponent(folderKey);
    const encodedItemId = encodeURIComponent(itemId);
    const encodedDisposition = encodeURIComponent(disposition);
    const path = `/sites/${encodedSiteId}/documents/folders/${encodedFolderKey}`
      + `/items/${encodedItemId}/content?disposition=${encodedDisposition}`;
    return requestBlob(path);
  },

  async projectFolderDocumentThumbnail(
    siteId: number,
    folderKey: string,
    itemId: string,
  ): Promise<Blob> {
    const encodedSiteId = encodeURIComponent(String(siteId));
    const encodedFolderKey = encodeURIComponent(folderKey);
    const encodedItemId = encodeURIComponent(itemId);
    return requestBlob(
      `/sites/${encodedSiteId}/documents/folders/${encodedFolderKey}/items/${encodedItemId}/thumbnail`,
    );
  },

  async uploadProjectFolderDocument(
    siteId: number,
    folderKey: string,
    file: File,
  ): Promise<ProjectFolderDocumentItem> {
    const formData = new FormData();
    formData.append("file", file);
    return request<ProjectFolderDocumentItem>(
      `/sites/${siteId}/documents/folders/${encodeURIComponent(folderKey)}/upload`,
      {
        method: "POST",
        body: formData,
      },
    );
  },


  async measurementBases(siteId: number): Promise<MeasurementBase[]> {
    return request<MeasurementBase[]>(`/sites/${siteId}/measurement-bases`);
  },

  async updateMeasurementBase(siteId: number, baseId: number, payload: MeasurementBaseUpdate): Promise<MeasurementBase> {
    return request<MeasurementBase>(`/sites/${siteId}/measurement-bases/${baseId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  },

  async activateMeasurementBase(siteId: number, baseId: number): Promise<MeasurementBase[]> {
    return request<MeasurementBase[]>(`/sites/${siteId}/measurement-bases/${baseId}/activate`, {
      method: "POST",
    });
  },

  async deleteMeasurementBase(siteId: number, baseId: number): Promise<MeasurementBase[]> {
    return request<MeasurementBase[]>(`/sites/${siteId}/measurement-bases/${baseId}`, {
      method: "DELETE",
    });
  },

  async measurementItems(siteId: number, params: { measurementBaseId?: number | null; activeOnly?: boolean } = {}): Promise<MeasurementItem[]> {
    const search = new URLSearchParams();
    if (params.measurementBaseId !== null && params.measurementBaseId !== undefined) {
      search.set("measurement_base_id", String(params.measurementBaseId));
    }
    if (params.activeOnly) {
      search.set("active_only", "true");
    }
    const suffix = search.toString() ? `?${search.toString()}` : "";
    return request<MeasurementItem[]>(`/sites/${siteId}/measurement-items${suffix}`);
  },

  async measurementTimesheet(siteId: number): Promise<MeasurementTimesheet> {
    return request<MeasurementTimesheet>(`/sites/${siteId}/measurement-timesheet`);
  },

  async hideMeasurementItem(siteId: number, measurementItemId: number): Promise<MeasurementItem> {
    return request<MeasurementItem>(`/sites/${siteId}/measurement-items/${measurementItemId}/hide`, {
      method: "POST",
    });
  },

  async measurementTimeAnalysis(siteId: number): Promise<MeasurementTimeAnalysis> {
    return request<MeasurementTimeAnalysis>(`/sites/${siteId}/measurement-time-analysis`);
  },

  async siteMeasurementBatches(
    siteId: number,
    params: { measurementBaseId?: number | null; activeOnly?: boolean; archivedOnly?: boolean } = {},
  ): Promise<MobileMeasurementBatch[]> {
    const search = new URLSearchParams();
    if (params.measurementBaseId !== null && params.measurementBaseId !== undefined) {
      search.set("measurement_base_id", String(params.measurementBaseId));
    }
    if (params.activeOnly) {
      search.set("active_only", "true");
    }
    if (params.archivedOnly) {
      search.set("archived_only", "true");
    }
    const suffix = search.toString() ? `?${search.toString()}` : "";
    return request<MobileMeasurementBatch[]>(`/sites/${siteId}/measurement-batches${suffix}`);
  },

  async siteMeasurementBatchItems(siteId: number, batchId: number): Promise<MobileMeasurementItem[]> {
    return request<MobileMeasurementItem[]>(`/sites/${siteId}/measurement-batches/${batchId}/items`);
  },

  async createSiteMeasurementFreeItem(
    siteId: number,
    batchId: number,
    payload: MobileMeasurementFreeItemPayload,
  ): Promise<MobileMeasurementItem> {
    return request<MobileMeasurementItem>(`/sites/${siteId}/measurement-batches/${batchId}/items`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async updateSiteMeasurementFreeItem(
    siteId: number,
    batchId: number,
    measurementItemId: number,
    payload: MeasurementItemUpdatePayload,
  ): Promise<MobileMeasurementItem> {
    return request<MobileMeasurementItem>(`/sites/${siteId}/measurement-batches/${batchId}/items/${measurementItemId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  },

  async markSiteMeasurementBatchBilled(siteId: number, batchId: number): Promise<MobileMeasurementBatch> {
    return request<MobileMeasurementBatch>(`/sites/${siteId}/measurement-batches/${batchId}/mark-billed`, {
      method: "POST",
    });
  },

  async markSiteMeasurementBatchOpen(siteId: number, batchId: number): Promise<MobileMeasurementBatch> {
    return request<MobileMeasurementBatch>(`/sites/${siteId}/measurement-batches/${batchId}/mark-open`, {
      method: "POST",
    });
  },

  async markSiteMeasurementBatchReviewed(siteId: number, batchId: number): Promise<MobileMeasurementBatch> {
    return request<MobileMeasurementBatch>(`/sites/${siteId}/measurement-batches/${batchId}/mark-reviewed`, {
      method: "POST",
    });
  },

  async resetSiteMeasurementBatchToSubmitted(siteId: number, batchId: number): Promise<MobileMeasurementItem[]> {
    return request<MobileMeasurementItem[]>(`/sites/${siteId}/measurement-batches/${batchId}/reset-to-submitted`, {
      method: "POST",
    });
  },

  async deleteSiteMeasurementBatch(siteId: number, batchId: number): Promise<void> {
    await request<void>(`/sites/${siteId}/measurement-batches/${batchId}`, {
      method: "DELETE",
    });
  },

  async restoreSiteMeasurementBatch(siteId: number, batchId: number): Promise<MobileMeasurementBatch> {
    return request<MobileMeasurementBatch>(`/sites/${siteId}/measurement-batches/${batchId}/restore`, {
      method: "POST",
    });
  },

  async downloadSiteMeasurementBatchPdf(siteId: number, batchId: number, mode: "checked" | "original" = "checked"): Promise<Blob> {
    return requestBlob(`/sites/${siteId}/measurement-batches/${batchId}/pdf?mode=${mode}`);
  },

  async siteExtraWorkTickets(siteId: number): Promise<MobileExtraWorkTicket[]> {
    return request<MobileExtraWorkTicket[]>(`/sites/${siteId}/extra-work-tickets`);
  },

  async downloadSiteExtraWorkTicketPdf(siteId: number, ticketId: number): Promise<Blob> {
    return requestBlob(`/sites/${siteId}/extra-work-tickets/${ticketId}/pdf`);
  },

  async deleteSiteExtraWorkTicket(siteId: number, ticketId: number): Promise<void> {
    await request<void>(`/sites/${siteId}/extra-work-tickets/${ticketId}`, {
      method: "DELETE",
    });
  },

  async createSiteMeasurementEntry(
    siteId: number,
    batchId: number,
    measurementItemId: number,
    payload: MeasurementEntryPayload,
  ): Promise<MeasurementEntry> {
    return request<MeasurementEntry>(`/sites/${siteId}/measurement-batches/${batchId}/items/${measurementItemId}/entries`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async updateSiteMeasurementEntry(
    siteId: number,
    batchId: number,
    entryId: number,
    payload: MeasurementEntryPayload,
  ): Promise<MeasurementEntry> {
    return request<MeasurementEntry>(`/sites/${siteId}/measurement-batches/${batchId}/entries/${entryId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  },

  async importMeasurementTimesheet(
    siteId: number,
    file: File,
    options: MeasurementImportOptions,
  ): Promise<MeasurementImportResponse> {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("import_mode", options.importMode);
    if (options.measurementBaseId) {
      formData.append("measurement_base_id", String(options.measurementBaseId));
    }
    if (options.measurementBaseName?.trim()) {
      formData.append("measurement_base_name", options.measurementBaseName.trim());
    }
    return request<MeasurementImportResponse>(`/sites/${siteId}/measurement-timesheet/import`, {
      method: "POST",
      body: formData,
    });
  },

  async removeSite(siteId: number): Promise<SiteRemoveResponse> {
    return request<SiteRemoveResponse>(`/sites/${siteId}`, { method: "DELETE" });
  },

  async absences(params: { start?: string; end?: string; personId?: number | null } = {}): Promise<Absence[]> {
    const search = new URLSearchParams();
    if (params.start) {
      search.set("start", params.start);
    }
    if (params.end) {
      search.set("end", params.end);
    }
    if (params.personId) {
      search.set("person_id", String(params.personId));
    }
    const suffix = search.toString() ? `?${search.toString()}` : "";
    return request<Absence[]>(`/absences${suffix}`);
  },

  async vacationCarryover(params: { personId: number; year: number }): Promise<VacationCarryover> {
    const search = new URLSearchParams({
      person_id: String(params.personId),
      year: String(params.year),
    });
    return request<VacationCarryover>(`/absences/vacation-carryover?${search.toString()}`);
  },

  async updateVacationCarryover(payload: VacationCarryoverUpdate): Promise<VacationCarryover> {
    return request<VacationCarryover>("/absences/vacation-carryover", {
      method: "PUT",
      body: JSON.stringify(payload),
    });
  },

  async createAbsence(payload: AbsenceCreate): Promise<Absence> {
    return request<Absence>("/absences", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async updateAbsence(absenceId: number, payload: AbsenceUpdate): Promise<Absence> {
    return request<Absence>(`/absences/${absenceId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  },

  async deleteAbsence(absenceId: number): Promise<void> {
    return request<void>(`/absences/${absenceId}`, { method: "DELETE" });
  },

  async dailyPlanPdf(planDate: string): Promise<Blob> {
    const search = new URLSearchParams({ date: planDate });
    return requestBlob(`/exports/daily-plan?${search.toString()}`);
  },

  async weeklyPlanPdf(weekStart: string): Promise<Blob> {
    const search = new URLSearchParams({ week_start: weekStart });
    return requestBlob(`/exports/weekly-plan?${search.toString()}`);
  },

  async monthlyTimeEntriesXlsx(params: { year: number; month: number }): Promise<Blob> {
    const search = new URLSearchParams({
      year: String(params.year),
      month: String(params.month),
    });
    return requestBlob(`/exports/time-entries/monthly-xlsx?${search.toString()}`);
  },

  async weeklyWorkerHoursPdf(params: { weekStart: string }): Promise<Blob> {
    const search = new URLSearchParams({ week_start: params.weekStart });
    return requestBlob(`/exports/time-entries/weekly-worker-hours.pdf?${search.toString()}`);
  },

  async weeklyAllWorkersTimeEntriesXlsx(params: { weekStart: string }): Promise<Blob> {
    const search = new URLSearchParams({ week_start: params.weekStart });
    return requestBlob(`/exports/time-entries/weekly-workers-xlsx?${search.toString()}`);
  },

  async weeklyWorkerTimeEntriesXlsx(params: { personId: number; weekStart: string }): Promise<Blob> {
    const search = new URLSearchParams({
      person_id: String(params.personId),
      week_start: params.weekStart,
    });
    return requestBlob(`/exports/time-entries/weekly-worker-xlsx?${search.toString()}`);
  },

  async myAssignments(params: { start: string; end: string }): Promise<MobileAssignmentsResponse> {
    const search = new URLSearchParams({ start: params.start, end: params.end });
    return request<MobileAssignmentsResponse>(`/me/assignments?${search.toString()}`);
  },

  async myAssignmentHistory(params: { start: string; end: string }): Promise<MobileAssignmentsResponse> {
    const search = new URLSearchParams({ start: params.start, end: params.end });
    return request<MobileAssignmentsResponse>(`/me/assignments/history?${search.toString()}`);
  },

  async mySites(): Promise<MobileSite[]> {
    return request<MobileSite[]>("/me/sites");
  },

  async recentlyPlannedSites(params: { months?: number } = {}): Promise<MobileSite[]> {
    const search = new URLSearchParams();
    if (params.months !== undefined) {
      search.set("months", String(params.months));
    }
    const suffix = search.toString() ? `?${search.toString()}` : "";
    return request<MobileSite[]>(`/me/sites/recently-planned${suffix}`);
  },

  async selfPlanAssignment(payload: { siteId: number; workDate: string }): Promise<MobileAssignment> {
    return request<MobileAssignment>("/me/assignments/self-plan", {
      method: "POST",
      body: JSON.stringify({
        site_id: payload.siteId,
        work_date: payload.workDate,
      }),
    });
  },

  async mobileMeasurementBatches(assignmentId: number): Promise<MobileMeasurementBatch[]> {
    return request<MobileMeasurementBatch[]>(`/me/assignments/${assignmentId}/measurement-batches`);
  },

  async createMobileMeasurementBatch(assignmentId: number): Promise<MobileMeasurementBatch> {
    return request<MobileMeasurementBatch>(`/me/assignments/${assignmentId}/measurement-batches`, {
      method: "POST",
    });
  },

  async submitMobileMeasurementBatch(
    assignmentId: number,
    batchId: number,
  ): Promise<MobileMeasurementBatch> {
    return request<MobileMeasurementBatch>(`/me/assignments/${assignmentId}/measurement-batches/${batchId}/submit`, {
      method: "POST",
    });
  },

  async mobileExtraWorkTickets(assignmentId: number): Promise<MobileExtraWorkTicket[]> {
    return request<MobileExtraWorkTicket[]>(`/me/assignments/${assignmentId}/extra-work-tickets`);
  },

  async assignmentEmailRecipients(assignmentId: number): Promise<SiteEmailRecipientsResponse> {
    return request<SiteEmailRecipientsResponse>(`/me/assignments/${assignmentId}/email-recipients`);
  },

  async updateAssignmentEmailRecipients(
    assignmentId: number,
    payload: SiteEmailRecipientsUpdate,
  ): Promise<SiteEmailRecipientsResponse> {
    return request<SiteEmailRecipientsResponse>(`/me/assignments/${assignmentId}/email-recipients`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
  },

  async createMobileExtraWorkTicket(
    assignmentId: number,
    payload: { kind?: "billing" | "approval"; approval_ticket_id?: number | null } = {},
  ): Promise<MobileExtraWorkTicket> {
    return request<MobileExtraWorkTicket>(`/me/assignments/${assignmentId}/extra-work-tickets`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async mobileExtraWorkTicket(assignmentId: number, ticketId: number): Promise<MobileExtraWorkTicket> {
    return request<MobileExtraWorkTicket>(`/me/assignments/${assignmentId}/extra-work-tickets/${ticketId}`);
  },

  async updateMobileExtraWorkTicketStatus(assignmentId: number, ticketId: number, status: "submitted"): Promise<MobileExtraWorkTicket> {
    return request<MobileExtraWorkTicket>(`/me/assignments/${assignmentId}/extra-work-tickets/${ticketId}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
  },

  async updateMobileExtraWorkTicketTitle(
    assignmentId: number,
    ticketId: number,
    title: string | null,
  ): Promise<MobileExtraWorkTicket> {
    return request<MobileExtraWorkTicket>(`/me/assignments/${assignmentId}/extra-work-tickets/${ticketId}/title`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    });
  },

  async mobileExtraWorkTicketEntry(assignmentId: number, ticketId: number): Promise<MobileExtraWorkTicketEntry | null> {
    return request<MobileExtraWorkTicketEntry | null>(`/me/assignments/${assignmentId}/extra-work-tickets/${ticketId}/entry`);
  },

  async saveMobileExtraWorkTicketEntry(
    assignmentId: number,
    ticketId: number,
    payload: MobileExtraWorkTicketEntryPayload,
  ): Promise<MobileExtraWorkTicketEntry> {
    return request<MobileExtraWorkTicketEntry>(`/me/assignments/${assignmentId}/extra-work-tickets/${ticketId}/entry`, {
      method: "PUT",
      body: JSON.stringify(payload),
    });
  },

  async mobileExtraWorkTicketPdf(assignmentId: number, ticketId: number): Promise<Blob> {
    return requestBlob(`/me/assignments/${assignmentId}/extra-work-tickets/${ticketId}/pdf`);
  },

  async sendMobileExtraWorkTicketEmail(
    assignmentId: number,
    ticketId: number,
  ): Promise<ExtraWorkTicketEmailSendResponse> {
    return request<ExtraWorkTicketEmailSendResponse>(`/me/assignments/${assignmentId}/extra-work-tickets/${ticketId}/send-email`, {
      method: "POST",
    });
  },

  async sendMobileMeasurementBatchEmail(
    assignmentId: number,
    batchId: number,
  ): Promise<ExtraWorkTicketEmailSendResponse> {
    return request<ExtraWorkTicketEmailSendResponse>(`/me/assignments/${assignmentId}/measurement-batches/${batchId}/send-email`, {
      method: "POST",
    });
  },

  async signMobileExtraWorkTicketCustomer(
    assignmentId: number,
    ticketId: number,
    payload: ExtraWorkCustomerSignaturePayload,
  ): Promise<MobileExtraWorkTicket> {
    return request<MobileExtraWorkTicket>(`/me/assignments/${assignmentId}/extra-work-tickets/${ticketId}/customer-signature`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async signMobileExtraWorkTicketWorker(
    assignmentId: number,
    ticketId: number,
    payload: WorkerSignaturePayload,
  ): Promise<MobileExtraWorkTicket> {
    return request<MobileExtraWorkTicket>(`/me/assignments/${assignmentId}/extra-work-tickets/${ticketId}/worker-signature`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async mobileExtraWorkTicketPhotos(
    assignmentId: number,
    ticketId: number,
  ): Promise<MobileExtraWorkTicketPhoto[]> {
    return request<MobileExtraWorkTicketPhoto[]>(`/me/assignments/${assignmentId}/extra-work-tickets/${ticketId}/photos`);
  },

  async uploadMobileExtraWorkTicketPhoto(
    assignmentId: number,
    ticketId: number,
    file: File,
  ): Promise<MobileExtraWorkTicketPhoto> {
    const formData = new FormData();
    formData.append("file", file, file.name);
    return request<MobileExtraWorkTicketPhoto>(`/me/assignments/${assignmentId}/extra-work-tickets/${ticketId}/photos`, {
      method: "POST",
      body: formData,
    });
  },

  async mobileExtraWorkTicketPhotoContent(
    assignmentId: number,
    ticketId: number,
    photoId: number,
  ): Promise<Blob> {
    return requestBlob(`/me/assignments/${assignmentId}/extra-work-tickets/${ticketId}/photos/${photoId}/content`);
  },

  async deleteMobileExtraWorkTicketPhoto(
    assignmentId: number,
    ticketId: number,
    photoId: number,
  ): Promise<void> {
    await request<void>(`/me/assignments/${assignmentId}/extra-work-tickets/${ticketId}/photos/${photoId}`, {
      method: "DELETE",
    });
  },

  async mobileMeasurementBatchPdf(assignmentId: number, batchId: number): Promise<Blob> {
    return requestBlob(`/me/assignments/${assignmentId}/measurement-batches/${batchId}/pdf?mode=checked`);
  },

  async mobileMeasurementTimesheetPdf(assignmentId: number): Promise<Blob> {
    return requestBlob(`/me/assignments/${assignmentId}/measurement-timesheet/pdf`);
  },

  async signMobileMeasurementBatch(
    assignmentId: number,
    batchId: number,
    payload: CustomerSignaturePayload,
  ): Promise<MobileMeasurementBatch> {
    return request<MobileMeasurementBatch>(`/me/assignments/${assignmentId}/measurement-batches/${batchId}/customer-signature`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async signMobileMeasurementBatchWorker(
    assignmentId: number,
    batchId: number,
    payload: WorkerSignaturePayload,
  ): Promise<MobileMeasurementBatch> {
    return request<MobileMeasurementBatch>(`/me/assignments/${assignmentId}/measurement-batches/${batchId}/worker-signature`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async mobileMeasurementBatchItems(assignmentId: number, batchId: number): Promise<MobileMeasurementItem[]> {
    return request<MobileMeasurementItem[]>(`/me/assignments/${assignmentId}/measurement-batches/${batchId}/items`);
  },

  async createMobileMeasurementFreeItem(
    assignmentId: number,
    batchId: number,
    payload: MobileMeasurementFreeItemPayload,
  ): Promise<MobileMeasurementItem> {
    return request<MobileMeasurementItem>(`/me/assignments/${assignmentId}/measurement-batches/${batchId}/items`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async createMobileMeasurementAreaRow(
    assignmentId: number,
    batchId: number,
    payload: MeasurementAreaRowPayload,
  ): Promise<MeasurementAreaRow> {
    return request<MeasurementAreaRow>(`/me/assignments/${assignmentId}/measurement-batches/${batchId}/area-rows`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async mobileMeasurementBatchPhotos(
    assignmentId: number,
    batchId: number,
  ): Promise<MobileMeasurementBatchPhoto[]> {
    return request<MobileMeasurementBatchPhoto[]>(`/me/assignments/${assignmentId}/measurement-batches/${batchId}/photos`);
  },

  async uploadMobileMeasurementBatchPhoto(
    assignmentId: number,
    batchId: number,
    file: File,
  ): Promise<MobileMeasurementBatchPhoto> {
    const formData = new FormData();
    formData.append("file", file, file.name);
    return request<MobileMeasurementBatchPhoto>(`/me/assignments/${assignmentId}/measurement-batches/${batchId}/photos`, {
      method: "POST",
      body: formData,
    });
  },

  async mobileMeasurementBatchPhotoContent(
    assignmentId: number,
    batchId: number,
    photoId: number,
  ): Promise<Blob> {
    return requestBlob(`/me/assignments/${assignmentId}/measurement-batches/${batchId}/photos/${photoId}/content`);
  },

  async deleteMobileMeasurementBatchPhoto(
    assignmentId: number,
    batchId: number,
    photoId: number,
  ): Promise<void> {
    await request<void>(`/me/assignments/${assignmentId}/measurement-batches/${batchId}/photos/${photoId}`, {
      method: "DELETE",
    });
  },

  async createMobileMeasurementEntry(
    assignmentId: number,
    batchId: number,
    measurementItemId: number,
    payload: MeasurementEntryPayload,
  ): Promise<MeasurementEntry> {
    return request<MeasurementEntry>(`/me/assignments/${assignmentId}/measurement-batches/${batchId}/items/${measurementItemId}/entries`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async deleteMobileMeasurementEntry(
    assignmentId: number,
    batchId: number,
    entryId: number,
  ): Promise<void> {
    return request<void>(`/me/assignments/${assignmentId}/measurement-batches/${batchId}/entries/${entryId}`, {
      method: "DELETE",
    });
  },

  async createAssignment(payload: Required<Pick<AssignmentPayload, "site_id" | "person_id" | "start_date" | "end_date">> & AssignmentPayload): Promise<AssignmentMutationApiResponse> {
    return request<AssignmentMutationApiResponse>("/assignments", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async updateAssignment(assignmentId: number, payload: AssignmentPayload): Promise<AssignmentMutationApiResponse> {
    return request<AssignmentMutationApiResponse>(`/assignments/${assignmentId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
  },

  async moveAssignmentSegment(assignmentId: number, payload: AssignmentSegmentMovePayload): Promise<AssignmentMutationApiResponse> {
    return request<AssignmentMutationApiResponse>(`/assignments/${assignmentId}/move-segment`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async deleteAssignment(assignmentId: number): Promise<AssignmentMutationApiResponse> {
    return request<AssignmentMutationApiResponse>(`/assignments/${assignmentId}`, { method: "DELETE" });
  },

  async deleteAssignmentDay(assignmentId: number, targetDate: string): Promise<AssignmentMutationApiResponse> {
    return request<AssignmentMutationApiResponse>(`/assignments/${assignmentId}/days/${targetDate}`, { method: "DELETE" });
  },

  async assignments(params: {
    start?: string;
    end?: string;
    personId?: number;
    siteId?: number;
  } = {}): Promise<AssignmentRead[]> {
    const search = new URLSearchParams();
    if (params.start) {
      search.set("start", params.start);
    }
    if (params.end) {
      search.set("end", params.end);
    }
    if (params.personId !== undefined) {
      search.set("person_id", String(params.personId));
    }
    if (params.siteId !== undefined) {
      search.set("site_id", String(params.siteId));
    }
    const suffix = search.toString() ? `?${search.toString()}` : "";
    return request<AssignmentRead[]>(`/assignments${suffix}`);
  },

  async matrix(params: {
    start: string;
    end: string;
    includeWeekends: boolean;
    yearView?: boolean;
    projectManagerPersonId?: number;
  }): Promise<MatrixResponse> {
    const search = new URLSearchParams({
      start: params.start,
      end: params.end,
      include_weekends: String(params.includeWeekends),
    });
    if (params.yearView) {
      search.set("year_view", "true");
    }
    if (params.projectManagerPersonId !== undefined) {
      search.set("project_manager_person_id", String(params.projectManagerPersonId));
    }
    return request<MatrixResponse>(`/matrix?${search.toString()}`);
  },

  async matrixVersion(params: {
    start: string;
    end: string;
    yearView?: boolean;
    projectManagerPersonId?: number;
  }): Promise<MatrixVersionResponse> {
    const search = new URLSearchParams({
      start: params.start,
      end: params.end,
    });
    if (params.yearView) {
      search.set("year_view", "true");
    }
    if (params.projectManagerPersonId !== undefined) {
      search.set("project_manager_person_id", String(params.projectManagerPersonId));
    }
    return request<MatrixVersionResponse>(`/matrix/version?${search.toString()}`);
  },

  async patchMatrixCell(params: {
    siteId: number;
    date: string;
    entries: MatrixEntryInput[];
  }): Promise<MatrixMutationResponse> {
    return request<MatrixMutationResponse>("/matrix/cell", {
      method: "PATCH",
      body: JSON.stringify({
        site_id: params.siteId,
        date: params.date,
        entries: params.entries,
      }),
    });
  },

  async patchMatrixCellMark(params: {
    siteId: number;
    date: string;
    mark: MatrixCellMark | null;
  }): Promise<MatrixMutationResponse> {
    return request<MatrixMutationResponse>("/matrix/cell-mark", {
      method: "PATCH",
      body: JSON.stringify({
        site_id: params.siteId,
        date: params.date,
        mark: params.mark,
      }),
    });
  },

  async patchMatrixRange(params: {
    siteId: number;
    startDate: string;
    endDate: string;
    entries: MatrixEntryInput[];
  }): Promise<MatrixMutationResponse> {
    return request<MatrixMutationResponse>("/matrix/range", {
      method: "PATCH",
      body: JSON.stringify({
        site_id: params.siteId,
        start_date: params.startDate,
        end_date: params.endDate,
        entries: params.entries,
      }),
    });
  },
};
