import { Plus, Save, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { EntityDetailDrawer } from "../components/EntityDetailDrawer";
import { ApiError, api } from "../lib/api";
import type { Person } from "../types/person";
import type { ToolMaterialItem, ToolMaterialItemCreate } from "../types/toolMaterial";

type MiscellaneousTabKey = "workerEvaluation" | "vehicles" | "toolsMaterial";

type MiscellaneousTab = {
  key: MiscellaneousTabKey;
  label: string;
};

type ToolMaterialDrawerState = { mode: "new" } | { mode: "edit"; itemId: number } | null;

type ToolMaterialDraft = {
  manufacturer: string;
  designation: string;
  item_type: string;
  device_number: string;
  serial_number: string;
  employee_id: string;
  item_date: string;
  delivery_note: string;
  remarks: string;
  supplier: string;
  invoice_number: string;
  stock: string;
};

const miscellaneousTabs: MiscellaneousTab[] = [
  { key: "workerEvaluation", label: "Monteurauswertung" },
  { key: "vehicles", label: "Fahrzeuge" },
  { key: "toolsMaterial", label: "Werkzeuge und Material" },
];

const emptyToolMaterialDraft: ToolMaterialDraft = {
  manufacturer: "",
  designation: "",
  item_type: "",
  device_number: "",
  serial_number: "",
  employee_id: "",
  item_date: "",
  delivery_note: "",
  remarks: "",
  supplier: "",
  invoice_number: "",
  stock: "",
};

export function MiscellaneousPage() {
  const [activeTabKey, setActiveTabKey] = useState<MiscellaneousTabKey>("workerEvaluation");
  const activeTab = useMemo(
    () => miscellaneousTabs.find((tab) => tab.key === activeTabKey) ?? miscellaneousTabs[0],
    [activeTabKey],
  );

  return (
    <section className="miscellaneous-page page-stack">
      <header className="page-header miscellaneous-page-header">
        <div>
          <h1>Sonstige</h1>
        </div>
      </header>

      <div className="project-record-tabs miscellaneous-tabs" role="tablist" aria-label="Sonstige Bereiche">
        {miscellaneousTabs.map((tab) => {
          const isActive = tab.key === activeTabKey;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={isActive ? "is-active" : undefined}
              onClick={() => setActiveTabKey(tab.key)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {activeTab.key === "toolsMaterial" ? (
        <ToolMaterialList />
      ) : (
        <MiscellaneousPlaceholderPanel activeTab={activeTab} />
      )}
    </section>
  );
}

function MiscellaneousPlaceholderPanel({ activeTab }: { activeTab: MiscellaneousTab }) {
  return (
    <section className="miscellaneous-placeholder-panel" role="tabpanel" aria-label={activeTab.label}>
      <h2>{activeTab.label}</h2>
      <p>Noch keine Inhalte hinterlegt.</p>
    </section>
  );
}

function ToolMaterialList() {
  const [items, setItems] = useState<ToolMaterialItem[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [drafts, setDrafts] = useState<Record<number, ToolMaterialDraft>>({});
  const [createDraft, setCreateDraft] = useState<ToolMaterialDraft>(emptyToolMaterialDraft);
  const [drawer, setDrawer] = useState<ToolMaterialDrawerState>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [savingItemId, setSavingItemId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function loadPeople() {
      try {
        const loadedPeople = await api.persons({ isActive: true });
        if (active) {
          setPeople([...loadedPeople].sort(comparePeople));
        }
      } catch (requestError) {
        if (active) {
          setError(readApiError(requestError, "Mitarbeiter konnten nicht geladen werden."));
        }
      }
    }
    void loadPeople();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    const timeoutId = window.setTimeout(() => {
      async function loadItems() {
        setIsLoading(true);
        setError(null);
        try {
          const loadedItems = await api.toolMaterialItems({ search: searchTerm });
          if (active) {
            setItems(loadedItems);
            setDrafts(toToolMaterialDrafts(loadedItems));
          }
        } catch (requestError) {
          if (active) {
            setError(readApiError(requestError, "Werkzeuge und Material konnten nicht geladen werden."));
          }
        } finally {
          if (active) {
            setIsLoading(false);
          }
        }
      }
      void loadItems();
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timeoutId);
    };
  }, [searchTerm]);

  async function refreshItems() {
    const loadedItems = await api.toolMaterialItems({ search: searchTerm });
    setItems(loadedItems);
    setDrafts(toToolMaterialDrafts(loadedItems));
  }

  const selectedItem = drawer?.mode === "edit"
    ? items.find((item) => item.id === drawer.itemId) ?? null
    : null;
  const selectedDraft = selectedItem ? drafts[selectedItem.id] ?? toToolMaterialDraft(selectedItem) : null;

  function openCreateDrawer() {
    setCreateDraft(emptyToolMaterialDraft);
    setError(null);
    setDrawer({ mode: "new" });
  }

  function openEditDrawer(itemId: number) {
    setError(null);
    setDrawer({ mode: "edit", itemId });
  }

  function closeDrawer() {
    if (selectedItem) {
      setDrafts((current) => ({ ...current, [selectedItem.id]: toToolMaterialDraft(selectedItem) }));
    }
    setCreateDraft(emptyToolMaterialDraft);
    setDrawer(null);
  }

  async function createItem() {
    const payload = toToolMaterialPayload(createDraft);
    if (!payload.designation.trim()) {
      setError("Bezeichnung darf nicht leer sein.");
      return;
    }
    setSavingItemId(0);
    setError(null);
    try {
      await api.createToolMaterialItem(payload);
      await refreshItems();
      setCreateDraft(emptyToolMaterialDraft);
      setDrawer(null);
    } catch (requestError) {
      setError(readApiError(requestError, "Eintrag konnte nicht angelegt werden."));
    } finally {
      setSavingItemId(null);
    }
  }

  async function saveItem(itemId: number) {
    const draft = drafts[itemId];
    if (!draft) {
      return;
    }
    const payload = toToolMaterialPayload(draft);
    if (!payload.designation.trim()) {
      setError("Bezeichnung darf nicht leer sein.");
      return;
    }
    setSavingItemId(itemId);
    setError(null);
    try {
      await api.updateToolMaterialItem(itemId, payload);
      await refreshItems();
      setDrawer(null);
    } catch (requestError) {
      setError(readApiError(requestError, "Eintrag konnte nicht gespeichert werden."));
    } finally {
      setSavingItemId(null);
    }
  }

  async function deleteItem(item: ToolMaterialItem) {
    if (!window.confirm(`${item.designation} wirklich löschen?`)) {
      return;
    }
    setSavingItemId(item.id);
    setError(null);
    try {
      await api.deleteToolMaterialItem(item.id);
      setItems((current) => current.filter((currentItem) => currentItem.id !== item.id));
      setDrafts((current) => {
        const next = { ...current };
        delete next[item.id];
        return next;
      });
      setDrawer(null);
    } catch (requestError) {
      setError(readApiError(requestError, "Eintrag konnte nicht gelöscht werden."));
    } finally {
      setSavingItemId(null);
    }
  }

  function updateDraft(itemId: number, values: Partial<ToolMaterialDraft>) {
    setDrafts((current) => ({
      ...current,
      [itemId]: { ...(current[itemId] ?? emptyToolMaterialDraft), ...values },
    }));
  }

  return (
    <section className="miscellaneous-tools-panel" role="tabpanel" aria-label="Werkzeuge und Material">
      <header className="miscellaneous-tools-header">
        <div>
          <h2>Werkzeuge und Material</h2>
          <p>Zentrale Bestands- und Zuordnungsliste.</p>
        </div>
        <button className="icon-button secondary miscellaneous-tools-add-button" type="button" onClick={openCreateDrawer}>
          <Plus aria-hidden="true" size={17} />
          <span>Eintrag hinzufügen</span>
        </button>
      </header>

      <div className="miscellaneous-tools-toolbar">
        <label className="overview-search miscellaneous-tools-search">
          <Search aria-hidden="true" size={17} />
          <input
            placeholder="Werkzeug oder Material suchen"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
          />
        </label>
      </div>

      {error && <p className="form-error">{error}</p>}
      {isLoading && <div className="matrix-state">Werkzeuge und Material werden geladen...</div>}

      {!isLoading && (
        <div className="miscellaneous-tools-table-wrap">
          <table className="miscellaneous-tools-table">
            <thead>
              <tr>
                <th>Fabrikat</th>
                <th>Bezeichnung</th>
                <th>Typ</th>
                <th>Gerätenummer</th>
                <th>Seriennummer</th>
                <th>Mitarbeiter</th>
                <th>Datum</th>
                <th>Lieferschein</th>
                <th>Bemerkungen</th>
                <th>Lieferant</th>
                <th>RG-Nr.</th>
                <th>Bestand</th>
              </tr>
            </thead>
            <tbody>
              {items.length ? items.map((item) => (
                <tr
                  className="miscellaneous-tools-row"
                  key={item.id}
                  tabIndex={0}
                  title="Eintrag bearbeiten"
                  onClick={() => openEditDrawer(item.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      openEditDrawer(item.id);
                    }
                  }}
                >
                  <td>{item.manufacturer ?? ""}</td>
                  <td><strong>{item.designation}</strong></td>
                  <td>{item.item_type ?? ""}</td>
                  <td>{item.device_number ?? ""}</td>
                  <td>{item.serial_number ?? ""}</td>
                  <td>{item.employee?.display_name ?? ""}</td>
                  <td>{formatDate(item.item_date)}</td>
                  <td>{item.delivery_note ?? ""}</td>
                  <td className="miscellaneous-tools-remarks"><span title={item.remarks ?? undefined}>{item.remarks ?? ""}</span></td>
                  <td>{item.supplier ?? ""}</td>
                  <td>{item.invoice_number ?? ""}</td>
                  <td>{item.stock ?? ""}</td>
                </tr>
              )) : (
                <tr>
                  <td className="miscellaneous-tools-empty" colSpan={12}>
                    {searchTerm.trim() ? "Keine Treffer gefunden." : "Noch keine Einträge vorhanden."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <EntityDetailDrawer
        isOpen={drawer?.mode === "new"}
        title="Eintrag hinzufügen"
        subtitle="Werkzeug oder Material erfassen"
        onClose={closeDrawer}
        footer={(
          <button className="icon-button" disabled={savingItemId === 0} type="button" onClick={() => void createItem()}>
            <Plus aria-hidden="true" size={17} />
            <span>Eintrag hinzufügen</span>
          </button>
        )}
      >
        <ToolMaterialFields
          draft={createDraft}
          people={people}
          onChange={(values) => setCreateDraft((current) => ({ ...current, ...values }))}
        />
      </EntityDetailDrawer>

      <EntityDetailDrawer
        isOpen={drawer?.mode === "edit" && Boolean(selectedItem && selectedDraft)}
        title="Eintrag bearbeiten"
        subtitle={selectedItem?.designation}
        onClose={closeDrawer}
        footer={selectedItem && selectedDraft ? (
          <div className="miscellaneous-tools-drawer-footer">
            <button
              className="icon-button danger"
              disabled={savingItemId === selectedItem.id}
              type="button"
              onClick={() => void deleteItem(selectedItem)}
            >
              <Trash2 aria-hidden="true" size={16} />
              <span>Löschen</span>
            </button>
            <div className="miscellaneous-tools-drawer-actions">
              <button className="icon-button secondary" disabled={savingItemId === selectedItem.id} type="button" onClick={closeDrawer}>
                <span>Abbrechen</span>
              </button>
              <button className="icon-button secondary" disabled={savingItemId === selectedItem.id} type="button" onClick={() => void saveItem(selectedItem.id)}>
                <Save aria-hidden="true" size={16} />
                <span>Speichern</span>
              </button>
            </div>
          </div>
        ) : undefined}
      >
        {selectedItem && selectedDraft && (
          <ToolMaterialFields
            draft={selectedDraft}
            people={people}
            onChange={(values) => updateDraft(selectedItem.id, values)}
          />
        )}
      </EntityDetailDrawer>
    </section>
  );
}

function ToolMaterialFields({
  draft,
  people,
  onChange,
}: {
  draft: ToolMaterialDraft;
  people: Person[];
  onChange: (values: Partial<ToolMaterialDraft>) => void;
}) {
  return (
    <div className="tool-material-form-grid">
      <label>
        <span>Fabrikat</span>
        <input value={draft.manufacturer} onChange={(event) => onChange({ manufacturer: event.target.value })} />
      </label>
      <label>
        <span>Bezeichnung</span>
        <input required value={draft.designation} onChange={(event) => onChange({ designation: event.target.value })} />
      </label>
      <label>
        <span>Typ</span>
        <input value={draft.item_type} onChange={(event) => onChange({ item_type: event.target.value })} />
      </label>
      <label>
        <span>Gerätenummer</span>
        <input value={draft.device_number} onChange={(event) => onChange({ device_number: event.target.value })} />
      </label>
      <label>
        <span>Seriennummer</span>
        <input value={draft.serial_number} onChange={(event) => onChange({ serial_number: event.target.value })} />
      </label>
      <label>
        <span>Mitarbeiter</span>
        <select value={draft.employee_id} onChange={(event) => onChange({ employee_id: event.target.value })}>
          <option value="">Keine Zuordnung</option>
          {people.map((person) => (
            <option key={person.id} value={person.id}>{person.display_name}</option>
          ))}
        </select>
      </label>
      <label>
        <span>Datum</span>
        <input type="date" value={draft.item_date} onChange={(event) => onChange({ item_date: event.target.value })} />
      </label>
      <label>
        <span>Lieferschein</span>
        <input value={draft.delivery_note} onChange={(event) => onChange({ delivery_note: event.target.value })} />
      </label>
      <label className="tool-material-form-wide">
        <span>Bemerkungen</span>
        <textarea rows={4} value={draft.remarks} onChange={(event) => onChange({ remarks: event.target.value })} />
      </label>
      <label>
        <span>Lieferant</span>
        <input value={draft.supplier} onChange={(event) => onChange({ supplier: event.target.value })} />
      </label>
      <label>
        <span>RG-Nr.</span>
        <input value={draft.invoice_number} onChange={(event) => onChange({ invoice_number: event.target.value })} />
      </label>
      <label>
        <span>Bestand</span>
        <input min="0" step="1" type="number" value={draft.stock} onChange={(event) => onChange({ stock: event.target.value })} />
      </label>
    </div>
  );
}

function toToolMaterialDraft(item: ToolMaterialItem): ToolMaterialDraft {
  return {
    manufacturer: item.manufacturer ?? "",
    designation: item.designation,
    item_type: item.item_type ?? "",
    device_number: item.device_number ?? "",
    serial_number: item.serial_number ?? "",
    employee_id: item.employee_id ? String(item.employee_id) : "",
    item_date: item.item_date ?? "",
    delivery_note: item.delivery_note ?? "",
    remarks: item.remarks ?? "",
    supplier: item.supplier ?? "",
    invoice_number: item.invoice_number ?? "",
    stock: item.stock === null ? "" : String(item.stock),
  };
}

function toToolMaterialDrafts(items: ToolMaterialItem[]): Record<number, ToolMaterialDraft> {
  return Object.fromEntries(items.map((item) => [item.id, toToolMaterialDraft(item)]));
}

function toToolMaterialPayload(draft: ToolMaterialDraft): ToolMaterialItemCreate {
  return {
    manufacturer: optionalText(draft.manufacturer),
    designation: draft.designation.trim(),
    item_type: optionalText(draft.item_type),
    device_number: optionalText(draft.device_number),
    serial_number: optionalText(draft.serial_number),
    employee_id: draft.employee_id ? Number(draft.employee_id) : null,
    item_date: draft.item_date || null,
    delivery_note: optionalText(draft.delivery_note),
    remarks: optionalText(draft.remarks),
    supplier: optionalText(draft.supplier),
    invoice_number: optionalText(draft.invoice_number),
    stock: optionalInteger(draft.stock),
  };
}

function optionalText(value: string): string | null {
  return value.trim() || null;
}

function optionalInteger(value: string): number | null {
  if (!value.trim()) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
}

function comparePeople(left: Person, right: Person): number {
  return left.display_name.localeCompare(right.display_name, "de");
}

function formatDate(value: string | null): string {
  if (!value) {
    return "";
  }
  return new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" }).format(
    new Date(`${value}T00:00:00`),
  );
}

function readApiError(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}
