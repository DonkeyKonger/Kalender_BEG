import type { Absence, AbsenceCreate, AbsenceUpdate } from "../types/absence";
import type { CurrentUser, LoginResponse } from "../types/auth";
import type { AdminUser, AdminUserCreate, AdminUserUpdate } from "../types/user";
import type { MatrixCellMark, MatrixEntryInput, MatrixMutationResponse, MatrixResponse } from "../types/matrix";
import type { Person, PersonCreate, PersonUpdate } from "../types/person";
import type { Site, SiteCreate, SiteUpdate } from "../types/site";
import type { MobileAssignmentsResponse } from "../types/mobile";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000/api";

export class ApiError extends Error {
  status: number;
  detail: unknown;

  constructor(status: number, detail: unknown) {
    super(typeof detail === "string" ? detail : "API-Anfrage fehlgeschlagen.");
    this.status = status;
    this.detail = detail;
  }
}

async function requestBlob(path: string): Promise<Blob> {
  const token = localStorage.getItem("kb_access_token");
  const headers = new Headers();
  headers.set("Accept", "application/pdf");
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(`${API_BASE_URL}${path}`, { headers });
  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    const payload = contentType.includes("application/json")
      ? await response.json()
      : await response.text();
    throw new ApiError(response.status, payload.detail ?? payload);
  }
  return response.blob();
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem("kb_access_token");
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body && !headers.has("Content-Type")) {
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
    return undefined as T;
  }

  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    throw new ApiError(response.status, payload.detail ?? payload);
  }

  return payload as T;
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

  async logout(): Promise<void> {
    return request<void>("/auth/logout", { method: "POST" });
  },

  async persons(params: { isActive?: boolean | null } = { isActive: true }): Promise<Person[]> {
    const search = new URLSearchParams();
    if (params.isActive !== null && params.isActive !== undefined) {
      search.set("is_active", String(params.isActive));
    }
    const suffix = search.toString() ? `?${search.toString()}` : "";
    return request<Person[]>(`/persons${suffix}`);
  },

  async users(): Promise<AdminUser[]> {
    return request<AdminUser[]>("/users");
  },

  async createPerson(payload: PersonCreate): Promise<Person> {
    return request<Person>("/persons", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async updatePerson(personId: number, payload: PersonUpdate): Promise<Person> {
    return request<Person>(`/persons/${personId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
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

  async sites(params: { includeClosed?: boolean } = {}): Promise<Site[]> {
    const search = new URLSearchParams();
    if (params.includeClosed) {
      search.set("include_closed", "true");
    }
    const suffix = search.toString() ? `?${search.toString()}` : "";
    return request<Site[]>(`/sites${suffix}`);
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

  async myAssignments(params: { start: string; end: string }): Promise<MobileAssignmentsResponse> {
    const search = new URLSearchParams({ start: params.start, end: params.end });
    return request<MobileAssignmentsResponse>(`/me/assignments?${search.toString()}`);
  },

  async myAssignmentHistory(params: { start: string; end: string }): Promise<MobileAssignmentsResponse> {
    const search = new URLSearchParams({ start: params.start, end: params.end });
    return request<MobileAssignmentsResponse>(`/me/assignments/history?${search.toString()}`);
  },

  async matrix(params: {
    start: string;
    end: string;
    includeWeekends: boolean;
  }): Promise<MatrixResponse> {
    const search = new URLSearchParams({
      start: params.start,
      end: params.end,
      include_weekends: String(params.includeWeekends),
    });
    return request<MatrixResponse>(`/matrix?${search.toString()}`);
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
