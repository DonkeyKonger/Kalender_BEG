import { Save, X } from "lucide-react";

import type { Person } from "../types/person";

export type MatrixCellEditorEntry = {
  key: string;
  label: string;
};

export type MatrixCellEditorActiveCell = {
  date: string;
  endDate: string;
};

export type MatrixCellEditorProps = {
  activeCell: MatrixCellEditorActiveCell;
  draftEntries: MatrixCellEditorEntry[];
  externalName: string;
  onAddExternal: () => void;
  onAddPerson: () => void;
  onEndDateChange: (date: string) => void;
  onExternalNameChange: (value: string) => void;
  onRemoveEntry: (key: string) => void;
  onSave: () => void;
  onSelectedPersonChange: (value: string) => void;
  people: Person[];
  selectedPersonId: string;
};

export function MatrixCellEditor({
  activeCell,
  draftEntries,
  externalName,
  onAddExternal,
  onAddPerson,
  onEndDateChange,
  onExternalNameChange,
  onRemoveEntry,
  onSave,
  onSelectedPersonChange,
  people,
  selectedPersonId,
}: MatrixCellEditorProps) {
  return (
    <div className="cell-editor" onClick={(event) => event.stopPropagation()}>
      <div className="editor-chip-list" aria-label="Geplante Personen">
        {draftEntries.map((entry) => (
          <button key={entry.key} type="button" onClick={() => onRemoveEntry(entry.key)}>
            <span>{entry.label}</span>
            <X aria-hidden="true" size={12} />
          </button>
        ))}
      </div>
      <div className="cell-editor-person-row">
        <select
          aria-label="Person auswaehlen"
          value={selectedPersonId}
          onChange={(event) => onSelectedPersonChange(event.target.value)}
        >
          <option value="">Person</option>
          {people.map((person) => (
            <option key={person.id} value={person.id}>
              {person.display_name}
            </option>
          ))}
        </select>
        <button type="button" onClick={onAddPerson} aria-label="Person hinzufuegen">
          +
        </button>
      </div>
      <input
        placeholder="Extern"
        value={externalName}
        onChange={(event) => onExternalNameChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            onAddExternal();
          }
        }}
      />
      <div className="cell-editor-date-row">
        <input
          aria-label="Bis Datum"
          min={activeCell.date}
          type="date"
          value={activeCell.endDate}
          onChange={(event) => onEndDateChange(event.target.value)}
        />
        <button className="save-cell-button" type="button" onClick={onSave} aria-label="Zelle speichern">
          <Save aria-hidden="true" size={13} />
        </button>
      </div>
    </div>
  );
}
