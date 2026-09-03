import { Check, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ApiError, api } from "../lib/api";
import {
  formatSignedHoursMinutes,
  parseSignedHoursMinutes,
  PAYROLL_CUTOVER_DATE,
  PAYROLL_OPENING_BALANCE_DATE,
  PAYROLL_WEEKDAY_LABELS,
  suggestWeekdayMinutes,
  sumWeekdayMinutes,
} from "../lib/payrollMonth";
import type { PayrollSetup, PayrollSetupWorker } from "../types/payrollMonth";

type PayrollSetupDialogProps = {
  open: boolean;
  onClose: () => void;
  onSetupChanged: () => void;
};

type WorkerDraft = {
  weekdayMinutes: number[];
  openingBalance: string;
};

export function PayrollSetupDialog({ open, onClose, onSetupChanged }: PayrollSetupDialogProps) {
  const [setup, setSetup] = useState<PayrollSetup | null>(null);
  const [drafts, setDrafts] = useState<Record<number, WorkerDraft>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    let ignore = false;
    setIsLoading(true);
    setError(null);
    api.payrollSetup(PAYROLL_CUTOVER_DATE)
      .then((response) => {
        if (!ignore) {
          applySetup(response);
        }
      })
      .catch((requestError) => {
        if (!ignore) {
          setError(readPayrollSetupError(requestError, "Einrichtung konnte nicht geladen werden."));
        }
      })
      .finally(() => {
        if (!ignore) {
          setIsLoading(false);
        }
      });
    return () => {
      ignore = true;
    };
  }, [open]);

  const confirmedCount = useMemo(() => (
    setup?.workers.filter((worker) => worker.plan?.is_confirmed && worker.opening_balance?.is_confirmed).length ?? 0
  ), [setup]);

  function applySetup(response: PayrollSetup): void {
    setSetup(response);
    setDrafts(Object.fromEntries(response.workers.map((worker) => [worker.person_id, draftForWorker(worker)])));
  }

  function setWeekdayMinutes(personId: number, weekdayIndex: number, value: string): void {
    const parsedValue = value === "" ? 0 : Number(value);
    setDrafts((current) => {
      const draft = current[personId];
      if (!draft) {
        return current;
      }
      const weekdayMinutes = [...draft.weekdayMinutes];
      weekdayMinutes[weekdayIndex] = Number.isFinite(parsedValue) ? Math.max(0, Math.round(parsedValue)) : 0;
      return { ...current, [personId]: { ...draft, weekdayMinutes } };
    });
  }

  function setOpeningBalance(personId: number, value: string): void {
    setDrafts((current) => ({
      ...current,
      [personId]: { ...current[personId], openingBalance: value },
    }));
  }

  async function confirmWeeklyPlan(worker: PayrollSetupWorker): Promise<void> {
    const draft = drafts[worker.person_id];
    if (!draft || worker.plan?.is_confirmed) {
      return;
    }
    const expectedMinutes = worker.weekly_hours === null ? null : Math.round(worker.weekly_hours * 60);
    if (expectedMinutes === null || sumWeekdayMinutes(draft.weekdayMinutes) !== expectedMinutes) {
      setError(`Der Wochenplan für ${worker.person_name} entspricht nicht den hinterlegten Wochenstunden.`);
      return;
    }
    setSavingKey(`plan:${worker.person_id}`);
    setError(null);
    try {
      const response = await api.confirmPayrollWeeklyPlan(worker.person_id, {
        valid_from: PAYROLL_CUTOVER_DATE,
        weekday_minutes: draft.weekdayMinutes,
        confirm: true,
      });
      applySetup(response);
      onSetupChanged();
    } catch (requestError) {
      setError(readPayrollSetupError(requestError, "Wochenplan konnte nicht bestätigt werden."));
    } finally {
      setSavingKey(null);
    }
  }

  async function confirmOpeningBalance(worker: PayrollSetupWorker): Promise<void> {
    const draft = drafts[worker.person_id];
    if (!draft || worker.opening_balance?.is_confirmed) {
      return;
    }
    const minutes = parseSignedHoursMinutes(draft.openingBalance);
    if (minutes === null) {
      setError(`Bitte den Eröffnungssaldo für ${worker.person_name} als +HH:MM, -HH:MM oder 0:00 eingeben.`);
      return;
    }
    setSavingKey(`balance:${worker.person_id}`);
    setError(null);
    try {
      const response = await api.confirmPayrollOpeningBalance(worker.person_id, {
        effective_date: PAYROLL_OPENING_BALANCE_DATE,
        minutes,
        confirm: true,
      });
      applySetup(response);
      onSetupChanged();
    } catch (requestError) {
      setError(readPayrollSetupError(requestError, "Eröffnungssaldo konnte nicht bestätigt werden."));
    } finally {
      setSavingKey(null);
    }
  }

  if (!open) {
    return null;
  }

  return (
    <div className="payroll-setup-backdrop" role="presentation" onClick={savingKey ? undefined : onClose}>
      <section
        aria-labelledby="payroll-setup-title"
        aria-modal="true"
        className="payroll-setup-dialog"
        role="dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="payroll-setup-head">
          <div>
            <span>Lohnprüfung</span>
            <h2 id="payroll-setup-title">Stundenkonto einrichten</h2>
            <p>Wochenpläne ab 01.08.2026 und Eröffnungssalden zum 31.07.2026 müssen einzeln bestätigt werden.</p>
          </div>
          <button aria-label="Einrichtung schließen" disabled={Boolean(savingKey)} type="button" onClick={onClose}>
            <X aria-hidden="true" size={18} />
          </button>
        </header>

        <div className="payroll-setup-summary" role="status">
          <strong>{confirmedCount} von {setup?.workers.length ?? 0} Monteuren vollständig bestätigt</strong>
          <span>{setup?.is_ready ? "Einrichtung abgeschlossen" : "Monatsabschluss bleibt bis zur vollständigen Bestätigung gesperrt"}</span>
        </div>

        {isLoading ? (
          <div className="payroll-setup-loading">Einrichtung wird geladen...</div>
        ) : setup ? (
          <div className="payroll-setup-worker-list">
            {setup.workers.map((worker) => {
              const draft = drafts[worker.person_id] ?? draftForWorker(worker);
              const expectedMinutes = worker.weekly_hours === null ? null : Math.round(worker.weekly_hours * 60);
              const weeklyMinutes = sumWeekdayMinutes(draft.weekdayMinutes);
              const weeklySumMatches = expectedMinutes !== null && expectedMinutes === weeklyMinutes;
              const balanceMinutes = parseSignedHoursMinutes(draft.openingBalance);
              return (
                <article className="payroll-setup-worker" key={worker.person_id}>
                  <header>
                    <div>
                      <h3>{worker.person_name}</h3>
                      <span>Monteursstamm: {worker.weekly_hours === null ? "nicht hinterlegt" : `${formatDecimal(worker.weekly_hours)} Std./Woche`}</span>
                    </div>
                    <span className={`payroll-setup-status${worker.plan?.is_confirmed && worker.opening_balance?.is_confirmed ? " is-confirmed" : ""}`}>
                      {worker.plan?.is_confirmed && worker.opening_balance?.is_confirmed ? <Check aria-hidden="true" size={14} /> : null}
                      {worker.plan?.is_confirmed && worker.opening_balance?.is_confirmed ? "Bestätigt" : "Noch nicht bestätigt"}
                    </span>
                  </header>

                  <div className="payroll-setup-section">
                    <div className="payroll-setup-section-title">
                      <strong>Wochenplan</strong>
                      <span>{worker.plan ? "Gespeicherter Plan" : "Vorausgefüllter Vorschlag – noch nicht verbindlich"}</span>
                    </div>
                    <div className="payroll-setup-weekdays">
                      {PAYROLL_WEEKDAY_LABELS.map((label, weekdayIndex) => (
                        <label key={label}>
                          <span>{label}</span>
                          <input
                            aria-label={`${worker.person_name}: ${label} in Minuten`}
                            disabled={Boolean(worker.plan?.is_confirmed) || Boolean(savingKey)}
                            inputMode="numeric"
                            min="0"
                            step="1"
                            type="number"
                            value={draft.weekdayMinutes[weekdayIndex] ?? 0}
                            onChange={(event) => setWeekdayMinutes(worker.person_id, weekdayIndex, event.target.value)}
                          />
                        </label>
                      ))}
                    </div>
                    <div className="payroll-setup-section-footer">
                      <span className={weeklySumMatches ? "is-valid" : "is-invalid"}>
                        Wochensumme: {formatMinutesAsHours(weeklyMinutes)}
                        {expectedMinutes !== null ? ` / ${formatMinutesAsHours(expectedMinutes)}` : " / Soll fehlt"}
                      </span>
                      {worker.plan?.is_confirmed ? (
                        <small>{confirmedBy(worker.plan.confirmed_by_name, worker.plan.confirmed_at)}</small>
                      ) : (
                        <button
                          disabled={!weeklySumMatches || Boolean(savingKey)}
                          type="button"
                          onClick={() => void confirmWeeklyPlan(worker)}
                        >
                          {savingKey === `plan:${worker.person_id}` ? "Wird bestätigt..." : "Wochenplan bestätigen"}
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="payroll-setup-section payroll-setup-balance">
                    <div className="payroll-setup-section-title">
                      <strong>Legacy-Eröffnungssaldo</strong>
                      <span>Historischer Vergleich: {formatSignedHoursMinutes(worker.historical_balance_minutes)}</span>
                    </div>
                    <label>
                      <span>Bestätigter Stand zum 31.07.2026</span>
                      <input
                        aria-label={`${worker.person_name}: Eröffnungssaldo zum 31.07.2026`}
                        disabled={Boolean(worker.opening_balance?.is_confirmed) || Boolean(savingKey)}
                        inputMode="text"
                        placeholder="+18:30"
                        type="text"
                        value={draft.openingBalance}
                        onChange={(event) => setOpeningBalance(worker.person_id, event.target.value)}
                      />
                    </label>
                    <div className="payroll-setup-section-footer">
                      <span className={balanceMinutes === null ? "is-invalid" : "is-valid"}>
                        {balanceMinutes === null ? "Format: +HH:MM, -HH:MM oder 0:00" : `${balanceMinutes} Minuten`}
                      </span>
                      {worker.opening_balance?.is_confirmed ? (
                        <small>{confirmedBy(worker.opening_balance.confirmed_by_name, worker.opening_balance.confirmed_at)}</small>
                      ) : (
                        <button
                          disabled={balanceMinutes === null || Boolean(savingKey)}
                          type="button"
                          onClick={() => void confirmOpeningBalance(worker)}
                        >
                          {savingKey === `balance:${worker.person_id}` ? "Wird bestätigt..." : "Saldo bestätigen"}
                        </button>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        ) : null}

        {error && <p className="payroll-setup-error" role="alert">{error}</p>}
        <footer className="payroll-setup-actions">
          <button disabled={Boolean(savingKey)} type="button" onClick={onClose}>Schließen</button>
        </footer>
      </section>
    </div>
  );
}

function draftForWorker(worker: PayrollSetupWorker): WorkerDraft {
  return {
    weekdayMinutes: worker.plan?.weekday_minutes.slice(0, 7) ?? suggestWeekdayMinutes(worker.weekly_hours),
    openingBalance: worker.opening_balance?.minutes === null || worker.opening_balance?.minutes === undefined
      ? ""
      : formatSignedHoursMinutes(worker.opening_balance.minutes).replace("−", "-"),
  };
}

function confirmedBy(name: string | null, timestamp: string | null): string {
  if (!name && !timestamp) {
    return "Bestätigt";
  }
  const formattedTimestamp = timestamp
    ? new Intl.DateTimeFormat("de-DE", { dateStyle: "short", timeStyle: "short" }).format(new Date(timestamp))
    : null;
  return [name ? `Bestätigt von ${name}` : "Bestätigt", formattedTimestamp].filter(Boolean).join(" · ");
}

function formatDecimal(value: number): string {
  return new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 }).format(value);
}

function formatMinutesAsHours(minutes: number): string {
  return `${formatDecimal(minutes / 60)} Std.`;
}

function readPayrollSetupError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    return error.message || fallback;
  }
  return fallback;
}
