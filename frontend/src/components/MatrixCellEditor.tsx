import { Save, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { Person } from "../types/person";

export type MatrixCellEditorEntry = {
  key: string;
  label: string;
};

export type MatrixCellEditorActiveCell = {
  date: string;
  endDate: string;
};

export type MatrixCellEditorContext = {
  siteName: string;
  siteNumber?: string | null;
  location?: string | null;
  dateLabel: string;
};

export type MatrixCellEditorProps = {
  activeCell: MatrixCellEditorActiveCell;
  cellMessage?: string;
  context: MatrixCellEditorContext;
  draftEntries: MatrixCellEditorEntry[];
  externalName: string;
  initialPersonQuery?: string;
  onAddExternal: () => void;
  onAddPerson: (personId?: string) => void;
  onClose: () => void;
  onPersonChosen?: (personId: string) => void;
  onEndDateChange: (date: string) => void;
  onExternalNameChange: (value: string) => void;
  onRemoveEntry: (key: string) => void;
  onSave: () => void;
  onSelectedPersonChange: (value: string) => void;
  people: Person[];
  saveStatus?: string;
  selectedPersonId: string;
};

export function MatrixCellEditor({
  activeCell,
  cellMessage,
  context,
  draftEntries,
  externalName,
  initialPersonQuery = "",
  onAddExternal,
  onAddPerson,
  onClose,
  onPersonChosen,
  onEndDateChange,
  onExternalNameChange,
  onRemoveEntry,
  onSave,
  onSelectedPersonChange,
  people,
  saveStatus,
  selectedPersonId,
}: MatrixCellEditorProps) {
  const [personQuery, setPersonQuery] = useState(initialPersonQuery);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [isExternalOpen, setIsExternalOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const suggestionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const assignedKeys = useMemo(() => new Set(draftEntries.map((entry) => entry.key)), [draftEntries]);
  const suggestions = useMemo(() => {
    const query = personQuery.trim().toLowerCase();
    const availablePeople = people.filter((person) => person.is_active && person.person_type === "internal");
    if (!query) {
      return [];
    }
    return availablePeople
      .filter((person) => {
        if (assignedKeys.has("p-" + person.id)) {
          return false;
        }
        return [person.display_name, person.first_name, person.last_name, person.short_code]
          .some((value) => value.toLowerCase().includes(query));
      })
      .slice(0, 6);
  }, [assignedKeys, people, personQuery]);

  useEffect(() => {
    setPersonQuery(initialPersonQuery);
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [initialPersonQuery]);

  useEffect(() => {
    setHighlightedIndex(suggestions.length === 1 ? 0 : -1);
  }, [personQuery, suggestions.length]);

  useEffect(() => {
    if (highlightedIndex < 0) {
      return;
    }
    suggestionRefs.current[highlightedIndex]?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex]);

  function addPerson(personId: string) {
    if (onPersonChosen) {
      onPersonChosen(personId);
    } else {
      onSelectedPersonChange(personId);
      onAddPerson(personId);
    }
    setPersonQuery("");
    setHighlightedIndex(-1);
  }

  function addExternal() {
    onAddExternal();
    setIsExternalOpen(false);
  }

  const hasEntries = draftEntries.length > 0;

  return (
    <div className="cell-editor" onClick={(event) => event.stopPropagation()}>
      <header className="cell-editor-header">
        <p className="cell-editor-eyebrow">Einsatz bearbeiten</p>
        <h2>{context.siteName}</h2>
        <div className="cell-editor-context">
          <span>{context.dateLabel}</span>
          {context.location && <span>{context.location}</span>}
          {context.siteNumber && <span>{context.siteNumber}</span>}
        </div>
      </header>

      <section className="cell-editor-section">
        <p className="cell-editor-label">Bereits eingeteilt</p>
        {hasEntries ? (
          <div className="editor-chip-list" aria-label="Geplante Personen">
            {draftEntries.map((entry) => (
              <button
                className={entry.key.startsWith("x-") ? "is-external" : ""}
                key={entry.key}
                type="button"
                onClick={() => onRemoveEntry(entry.key)}
              >
                <span>{entry.label}</span>
                <X aria-hidden="true" size={13} />
              </button>
            ))}
          </div>
        ) : (
          <p className="cell-editor-empty">Noch niemand eingeteilt</p>
        )}
      </section>

      <section className="cell-editor-section">
        <label className="cell-editor-label" htmlFor="matrix-person-search">Monteur hinzufügen</label>
        <input
          id="matrix-person-search"
          placeholder="Person suchen..."
          value={personQuery}
          ref={inputRef}
          onChange={(event) => setPersonQuery(event.target.value)}
          aria-activedescendant={highlightedIndex >= 0 ? `matrix-person-suggestion-${suggestions[highlightedIndex]?.id}` : undefined}
          aria-controls="matrix-person-suggestions"
          aria-expanded={suggestions.length > 0}
          role="combobox"
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" && suggestions.length > 0) {
              event.preventDefault();
              setHighlightedIndex((current) => (current < 0 ? 0 : (current + 1) % suggestions.length));
              return;
            }
            if (event.key === "ArrowUp" && suggestions.length > 0) {
              event.preventDefault();
              setHighlightedIndex((current) => (current < 0 ? suggestions.length - 1 : current <= 0 ? suggestions.length - 1 : current - 1));
              return;
            }
            if (event.key === "Enter") {
              const selectedSuggestion = highlightedIndex >= 0 ? suggestions[highlightedIndex] : suggestions.length === 1 ? suggestions[0] : null;
              if (selectedSuggestion) {
                event.preventDefault();
                addPerson(String(selectedSuggestion.id));
              }
              return;
            }
            if (event.key === "Escape" && (personQuery || suggestions.length > 0)) {
              event.preventDefault();
              event.stopPropagation();
              setPersonQuery("");
              setHighlightedIndex(-1);
            }
          }}
        />
        {personQuery && suggestions.length === 0 && (
          <p className="cell-editor-empty">Keine passende Person gefunden</p>
        )}
        {suggestions.length > 0 && (
          <div
            className="cell-editor-suggestions"
            id="matrix-person-suggestions"
            role="listbox"
            aria-label="Personenvorschlaege"
          >
            {suggestions.map((person, index) => (
              <button
                aria-selected={highlightedIndex === index}
                className={highlightedIndex === index ? "is-highlighted" : ""}
                id={`matrix-person-suggestion-${person.id}`}
                key={person.id}
                ref={(element) => {
                  suggestionRefs.current[index] = element;
                }}
                role="option"
                type="button"
                onClick={() => addPerson(String(person.id))}
                onMouseEnter={() => setHighlightedIndex(index)}
              >
                <span>{person.display_name}</span>
                <small>{person.short_code}</small>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="cell-editor-section">
        {!isExternalOpen ? (
          <button className="cell-editor-link" type="button" onClick={() => setIsExternalOpen(true)}>
            + Externen Mitarbeiter eintragen
          </button>
        ) : (
          <div className="cell-editor-external">
            <label className="cell-editor-label" htmlFor="matrix-external-name">Name externer Mitarbeiter</label>
            <div className="cell-editor-person-row">
              <input
                id="matrix-external-name"
                placeholder="Freitext eingeben..."
                value={externalName}
                onChange={(event) => onExternalNameChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addExternal();
                  }
                }}
              />
              <button type="button" onClick={addExternal} aria-label="Externen Mitarbeiter hinzufuegen">
                +
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="cell-editor-section cell-editor-date-section">
        <label className="cell-editor-label" htmlFor="matrix-end-date">Bis Datum</label>
        <input
          id="matrix-end-date"
          aria-label="Bis Datum"
          min={activeCell.date}
          type="date"
          value={activeCell.endDate}
          onChange={(event) => onEndDateChange(event.target.value)}
        />
      </section>

      {(saveStatus || cellMessage) && (
        <div className="matrix-cell-editor-status">
          {saveStatus && <span className={'save-dot ' + saveStatus} />}
          {cellMessage && <small className={saveStatus === "error" ? "is-error" : ""}>{cellMessage}</small>}
        </div>
      )}

      <footer className="cell-editor-actions">
        <button className="cell-editor-secondary" type="button" onClick={onClose}>
          Schließen
        </button>
        <button className="cell-editor-primary" type="button" onClick={onSave} disabled={saveStatus === "saving"}>
          <Save aria-hidden="true" size={14} />
          <span>{saveStatus === "saving" ? "Speichert..." : "Speichern"}</span>
        </button>
      </footer>
      <input type="hidden" value={selectedPersonId} readOnly />
    </div>
  );
}
