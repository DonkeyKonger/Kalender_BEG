import { Clock3 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { ApiError, api } from "../lib/api";
import type { Person } from "../types/person";

type RangeMode = "week" | "month";

export function TimeEntriesPage() {
  const [people, setPeople] = useState<Person[]>([]);
  const [selectedPersonId, setSelectedPersonId] = useState<number | null>(null);
  const [rangeMode, setRangeMode] = useState<RangeMode>("week");
  const [searchTerm, setSearchTerm] = useState("");
  const [isLoadingPeople, setIsLoadingPeople] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadPeople();
  }, []);

  async function loadPeople() {
    setIsLoadingPeople(true);
    setError(null);
    try {
      const personData = await api.persons({ isActive: true });
      setPeople(personData.sort(comparePeople));
    } catch (requestError) {
      setError(readApiError(requestError, "Monteure konnten nicht geladen werden."));
    } finally {
      setIsLoadingPeople(false);
    }
  }

  const filteredPeople = useMemo(() => {
    const needle = searchTerm.trim().toLowerCase();
    if (!needle) {
      return people;
    }
    return people.filter((person) => personSearchText(person).includes(needle));
  }, [people, searchTerm]);

  const selectedPerson = useMemo(
    () => people.find((person) => person.id === selectedPersonId) ?? null,
    [people, selectedPersonId],
  );

  const activeRange = useMemo(
    () => (rangeMode === "week" ? currentWeekRange() : currentMonthRange()),
    [rangeMode],
  );

  return (
    <section className="time-entries-page">
      <div className="page-header entity-page-header">
        <div>
          <p className="eyebrow">Arbeitszeiten</p>
          <h1>Zeiten</h1>
          <p className="page-subtitle">Arbeitszeiten der Monteure wochen- oder monatsweise pruefen.</p>
        </div>
      </div>

      {error && <p className="form-error">{error}</p>}

      <div className="time-entries-layout">
        <aside className="time-entries-sidebar">
          <div className="time-panel-header">
            <div>
              <h2>Monteure</h2>
              <p>Person auswaehlen, um den Zeitraum vorzubereiten.</p>
            </div>
          </div>
          <input
            className="entity-search"
            placeholder="Monteur suchen"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
          />
          {isLoadingPeople ? (
            <div className="matrix-state">Monteure werden geladen...</div>
          ) : (
            <div className="time-person-list">
              {filteredPeople.map((person) => (
                <button
                  className={person.id === selectedPersonId ? "is-active" : ""}
                  key={person.id}
                  type="button"
                  onClick={() => setSelectedPersonId(person.id)}
                >
                  <strong>{person.display_name}</strong>
                  <span>{person.short_code || `${person.first_name} ${person.last_name}`.trim()}</span>
                </button>
              ))}
              {!filteredPeople.length && <p className="detail-empty">Keine Monteure gefunden.</p>}
            </div>
          )}
        </aside>

        <div className="time-entries-main">
          <div className="time-entries-toolbar">
            <div>
              <h2>{selectedPerson?.display_name ?? "Monteur auswaehlen"}</h2>
              <p>{formatRangeLabel(activeRange.start, activeRange.end)}</p>
            </div>
            <div className="time-range-controls">
              <div className="matrix-pm-filter" aria-label="Zeitraum">
                <button className={rangeMode === "week" ? "is-active" : ""} type="button" onClick={() => setRangeMode("week")}>
                  Aktuelle Woche
                </button>
                <button className={rangeMode === "month" ? "is-active" : ""} type="button" onClick={() => setRangeMode("month")}>
                  Aktueller Monat
                </button>
              </div>
            </div>
          </div>

          {!selectedPerson ? (
            <div className="empty-panel">
              <Clock3 aria-hidden="true" size={18} />
              <p>Bitte Monteur auswaehlen.</p>
            </div>
          ) : (
            <div className="time-table-panel">
              <div className="time-table-scroll">
                <table className="time-entries-table">
                  <thead>
                    <tr>
                      <th>Datum</th>
                      <th>Tag</th>
                      <th>Geplante Baustelle</th>
                      <th>Gemeldete Baustelle</th>
                      <th>Arbeitszeit</th>
                      <th>Pause</th>
                      <th>Fahrtzeit</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="time-empty-row" colSpan={8}>
                        Fuer diesen Zeitraum sind noch keine Arbeitszeiten erfasst.
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function currentMonthRange(): { start: string; end: string } {
  const today = new Date();
  return {
    start: toDateInputValue(new Date(today.getFullYear(), today.getMonth(), 1)),
    end: toDateInputValue(new Date(today.getFullYear(), today.getMonth() + 1, 0)),
  };
}

function currentWeekRange(): { start: string; end: string } {
  const today = new Date();
  const mondayOffset = (today.getDay() + 6) % 7;
  const monday = new Date(today);
  monday.setDate(today.getDate() - mondayOffset);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { start: toDateInputValue(monday), end: toDateInputValue(sunday) };
}

function toDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateInput(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" }).format(parseDateInput(value));
}

function formatRangeLabel(start: string, end: string): string {
  return `${formatDate(start)} bis ${formatDate(end)}`;
}

function comparePeople(left: Person, right: Person): number {
  return left.display_name.localeCompare(right.display_name, "de");
}

function personSearchText(person: Person): string {
  return [
    person.display_name,
    person.first_name,
    person.last_name,
    person.short_code,
  ].filter(Boolean).join(" ").toLowerCase();
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
