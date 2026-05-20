import { CalendarDays, Download, FileText } from "lucide-react";
import { useMemo, useState } from "react";

import { ApiError, api } from "../lib/api";

export function ExportsPage() {
  const today = useMemo(() => toIsoDate(new Date()), []);
  const currentWeekStart = useMemo(() => toIsoDate(mondayOf(new Date())), []);
  const [dailyDate, setDailyDate] = useState(today);
  const [weekStart, setWeekStart] = useState(currentWeekStart);
  const [isLoading, setIsLoading] = useState<"daily" | "weekly" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function downloadDailyPlan() {
    await downloadPdf({
      loader: () => api.dailyPlanPdf(dailyDate),
      filename: `tagesplan-${dailyDate}.pdf`,
      loadingKey: "daily",
      setError,
      setIsLoading,
    });
  }

  async function downloadWeeklyPlan() {
    const normalizedWeekStart = toIsoDate(mondayOf(new Date(`${weekStart}T00:00:00`)));
    setWeekStart(normalizedWeekStart);
    await downloadPdf({
      loader: () => api.weeklyPlanPdf(normalizedWeekStart),
      filename: `wochenplan-${normalizedWeekStart}.pdf`,
      loadingKey: "weekly",
      setError,
      setIsLoading,
    });
  }

  return (
    <section className="exports-page">
      <div className="page-header">
        <div>
          <p className="eyebrow">Fallback</p>
          <h1>Exporte</h1>
        </div>
      </div>

      {error && <p className="form-error">{error}</p>}

      <div className="export-grid">
        <section className="export-panel">
          <h2><FileText aria-hidden="true" size={18} />Tagesplan</h2>
          <label>
            <span>Datum</span>
            <input type="date" value={dailyDate} onChange={(event) => setDailyDate(event.target.value)} />
          </label>
          <button className="icon-button" disabled={isLoading === "daily"} type="button" onClick={() => void downloadDailyPlan()}>
            <Download aria-hidden="true" size={17} />
            <span>{isLoading === "daily" ? "Erstelle PDF..." : "Tagesplan PDF"}</span>
          </button>
        </section>

        <section className="export-panel">
          <h2><CalendarDays aria-hidden="true" size={18} />Wochenplan</h2>
          <label>
            <span>Woche ab</span>
            <input type="date" value={weekStart} onChange={(event) => setWeekStart(event.target.value)} />
          </label>
          <button className="icon-button" disabled={isLoading === "weekly"} type="button" onClick={() => void downloadWeeklyPlan()}>
            <Download aria-hidden="true" size={17} />
            <span>{isLoading === "weekly" ? "Erstelle PDF..." : "Wochenplan PDF"}</span>
          </button>
        </section>
      </div>
    </section>
  );
}

async function downloadPdf({
  loader,
  filename,
  loadingKey,
  setError,
  setIsLoading,
}: {
  loader: () => Promise<Blob>;
  filename: string;
  loadingKey: "daily" | "weekly";
  setError: (value: string | null) => void;
  setIsLoading: (value: "daily" | "weekly" | null) => void;
}) {
  setError(null);
  setIsLoading(loadingKey);
  try {
    const blob = await loader();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (requestError) {
    setError(readApiError(requestError, "PDF konnte nicht erstellt werden."));
  } finally {
    setIsLoading(null);
  }
}

function mondayOf(date: Date): Date {
  const result = new Date(date);
  const day = result.getDay() || 7;
  result.setDate(result.getDate() - day + 1);
  return result;
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function readApiError(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) {
    return fallback;
  }
  if (typeof error.detail === "string") {
    return error.detail;
  }
  return error.message;
}
