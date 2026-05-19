import type { CurrentUser, LoginResponse } from "../types/auth";
import type { MatrixEntryInput, MatrixMutationResponse, MatrixResponse } from "../types/matrix";
import type { Person } from "../types/person";
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

  async persons(): Promise<Person[]> {
    return request<Person[]>("/persons?is_active=true");
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
