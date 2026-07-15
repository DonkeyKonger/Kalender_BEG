import { ArrowDownAZ, ArrowUpAZ, Check, ChevronDown, ListFilter, LoaderCircle, Plus, RotateCcw, Save, Search, Trash2 } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { DashboardNotePicker } from "../components/DashboardNotePickers";
import { EntityDetailDrawer } from "../components/EntityDetailDrawer";
import { ApiError, api } from "../lib/api";
import { buildToolMaterialEmployeeOptions } from "../lib/toolMaterialEmployees";
import {
  getOptimisticToolMaterialStatusItem,
  getSuggestedToolMaterialStatus,
  getToolMaterialStatusChange,
  getToolMaterialStatusPresentation,
  saveToolMaterialStatus,
  toolMaterialStatusOptions,
} from "../lib/toolMaterialStatus";
import {
  clearAllToolMaterialFilters,
  clearToolMaterialColumnFilter,
  hasToolMaterialFilters,
  isToolMaterialColumnFilterActive,
  toolMaterialColumns,
  type ToolMaterialColumn,
  type ToolMaterialColumnFilter,
  type ToolMaterialColumnKey,
  type ToolMaterialFilters,
  type ToolMaterialSortDirection,
} from "../lib/toolMaterialFilters";
import type { Person } from "../types/person";
import type { ToolMaterialEmployee, ToolMaterialFilterOption, ToolMaterialFilterOptions, ToolMaterialItem, ToolMaterialItemCreate, ToolMaterialStatus } from "../types/toolMaterial";

type MiscellaneousTabKey = "workerEvaluation" | "vehicles" | "toolsMaterial";

type MiscellaneousTab = {
  key: MiscellaneousTabKey;
  label: string;
};

type ToolMaterialDrawerState = { mode: "new" } | { mode: "edit"; itemId: number } | null;

type ToolMaterialDraft = {
  beg_number: string;
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
  status: ToolMaterialStatus;
};

const miscellaneousTabs: MiscellaneousTab[] = [
  { key: "workerEvaluation", label: "Monteurauswertung" },
  { key: "vehicles", label: "Fahrzeuge" },
  { key: "toolsMaterial", label: "Werkzeuge und Material" },
];

const emptyToolMaterialDraft: ToolMaterialDraft = {
  beg_number: "",
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
  status: "warehouse",
};

export function MiscellaneousPage() {
  const [activeTabKey, setActiveTabKey] = useState<MiscellaneousTabKey>("workerEvaluation");
  const activeTab = useMemo(
    () => miscellaneousTabs.find((tab) => tab.key === activeTabKey) ?? miscellaneousTabs[0],
    [activeTabKey],
  );

  return (
    <section className={`miscellaneous-page page-stack${activeTab.key === "toolsMaterial" ? " has-tools-material" : ""}`}>
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
  const [filters, setFilters] = useState<ToolMaterialFilters>({});
  const [sortBy, setSortBy] = useState<ToolMaterialColumnKey>("designation");
  const [sortDirection, setSortDirection] = useState<ToolMaterialSortDirection>("asc");
  const [activeFilterKey, setActiveFilterKey] = useState<ToolMaterialColumnKey | null>(null);
  const [filterOptions, setFilterOptions] = useState<ToolMaterialFilterOptions>({ columns: {} });
  const [isLoading, setIsLoading] = useState(true);
  const [hasLoadedItems, setHasLoadedItems] = useState(false);
  const [peopleLoading, setPeopleLoading] = useState(true);
  const [peopleError, setPeopleError] = useState<string | null>(null);
  const [savingItemId, setSavingItemId] = useState<number | null>(null);
  const [savingStatusItemId, setSavingStatusItemId] = useState<number | null>(null);
  const savingStatusItemIdRef = useRef<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function loadPeople() {
      setPeopleLoading(true);
      setPeopleError(null);
      try {
        const loadedPeople = await api.persons({ isActive: null });
        if (active) {
          setPeople(loadedPeople);
        }
      } catch (requestError) {
        if (active) {
          setPeopleError(readApiError(requestError, "Mitarbeiter konnten nicht geladen werden."));
        }
      } finally {
        if (active) {
          setPeopleLoading(false);
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
    async function loadFilterOptions() {
      try {
        const loadedOptions = await api.toolMaterialFilterOptions();
        if (active) {
          setFilterOptions(loadedOptions);
        }
      } catch (requestError) {
        if (active) {
          setError(readApiError(requestError, "Filterwerte konnten nicht geladen werden."));
        }
      }
    }
    void loadFilterOptions();
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
          const loadedItems = await api.toolMaterialItems({
            search: searchTerm,
            filters,
            sortBy,
            sortDirection,
          });
          if (active) {
            setItems(loadedItems);
            setDrafts(toToolMaterialDrafts(loadedItems));
            setHasLoadedItems(true);
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
  }, [filters, searchTerm, sortBy, sortDirection]);

  async function refreshItems() {
    const [loadedItems, loadedOptions] = await Promise.all([
      api.toolMaterialItems({ search: searchTerm, filters, sortBy, sortDirection }),
      api.toolMaterialFilterOptions(),
    ]);
    setItems(loadedItems);
    setDrafts(toToolMaterialDrafts(loadedItems));
    setFilterOptions(loadedOptions);
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
    if (!payload.beg_number.trim()) {
      setError("BEG-Nr. darf nicht leer sein.");
      return;
    }
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

  async function changeStatus(item: ToolMaterialItem, nextStatus: ToolMaterialStatus) {
    if (item.status === nextStatus || savingStatusItemIdRef.current !== null) {
      return;
    }
    const previousDraft = drafts[item.id] ?? toToolMaterialDraft(item);
    const optimisticItem = getOptimisticToolMaterialStatusItem(item, nextStatus);
    savingStatusItemIdRef.current = item.id;
    setSavingStatusItemId(item.id);
    setError(null);
    setItems((current) => current.map((currentItem) => (
      currentItem.id === item.id ? optimisticItem : currentItem
    )));
    setDrafts((current) => ({ ...current, [item.id]: toToolMaterialDraft(optimisticItem) }));

    const result = await saveToolMaterialStatus(item, nextStatus, api.updateToolMaterialItem);
    if (!result.ok) {
      setItems((current) => current.map((currentItem) => (
        currentItem.id === item.id ? result.item : currentItem
      )));
      setDrafts((current) => ({ ...current, [item.id]: previousDraft }));
      setError(readApiError(result.error, "Status konnte nicht gespeichert werden."));
      savingStatusItemIdRef.current = null;
      setSavingStatusItemId(null);
      return;
    }

    setItems((current) => current.map((currentItem) => (
      currentItem.id === item.id ? result.item : currentItem
    )));
    setDrafts((current) => ({ ...current, [item.id]: toToolMaterialDraft(result.item) }));
    try {
      await refreshItems();
    } catch (requestError) {
      setError(readApiError(
        requestError,
        "Der Status wurde gespeichert, die Tabelle konnte aber nicht neu geladen werden.",
      ));
    } finally {
      savingStatusItemIdRef.current = null;
      setSavingStatusItemId(null);
    }
  }

  function updateDraft(itemId: number, values: Partial<ToolMaterialDraft>) {
    setDrafts((current) => ({
      ...current,
      [itemId]: { ...(current[itemId] ?? emptyToolMaterialDraft), ...values },
    }));
  }

  function updateColumnFilter(key: ToolMaterialColumnKey, nextFilter: ToolMaterialColumnFilter) {
    setFilters((current) => ({ ...current, [key]: nextFilter }));
  }

  function resetColumnFilter(key: ToolMaterialColumnKey) {
    setFilters((current) => clearToolMaterialColumnFilter(current, key));
  }

  function updateSort(key: ToolMaterialColumnKey, direction: ToolMaterialSortDirection) {
    setSortBy(key);
    setSortDirection(direction);
  }

  const filtersActive = hasToolMaterialFilters(filters);

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
        {filtersActive ? (
          <button
            className="miscellaneous-tools-reset-filters"
            type="button"
            onClick={() => {
              setFilters(clearAllToolMaterialFilters());
              setActiveFilterKey(null);
            }}
          >
            <RotateCcw aria-hidden="true" size={14} />
            <span>Alle Filter zurücksetzen</span>
          </button>
        ) : null}
      </div>

      {error && <p className="form-error">{error}</p>}
      {isLoading && !hasLoadedItems && <div className="matrix-state">Werkzeuge und Material werden geladen...</div>}

      {hasLoadedItems && (
        <div className="miscellaneous-tools-table-wrap">
          <table className="miscellaneous-tools-table">
            <colgroup>
              {toolMaterialColumns.map((column) => (
                <col
                  className={`tool-material-col-${column.key.replaceAll("_", "-")}`}
                  key={column.key}
                />
              ))}
            </colgroup>
            <thead>
              <tr>
                {toolMaterialColumns.map((column) => (
                  <ToolMaterialFilterHeader
                    column={column}
                    filter={filters[column.key]}
                    isOpen={activeFilterKey === column.key}
                    isSorted={sortBy === column.key}
                    key={column.key}
                    options={filterOptions.columns[column.key] ?? []}
                    sortDirection={sortDirection}
                    onChange={(nextFilter) => updateColumnFilter(column.key, nextFilter)}
                    onOpenChange={(open) => setActiveFilterKey(open ? column.key : null)}
                    onReset={() => resetColumnFilter(column.key)}
                    onSort={(direction) => updateSort(column.key, direction)}
                  />
                ))}
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
                  <td title={item.beg_number ?? undefined}><strong>{item.beg_number ?? ""}</strong></td>
                  <td title={item.manufacturer ?? undefined}>{item.manufacturer ?? ""}</td>
                  <td title={item.designation}><strong>{item.designation}</strong></td>
                  <td title={item.item_type ?? undefined}>{item.item_type ?? ""}</td>
                  <td title={item.device_number ?? undefined}>{item.device_number ?? ""}</td>
                  <td title={item.serial_number ?? undefined}>{item.serial_number ?? ""}</td>
                  <td title={item.employee?.display_name}>{item.employee?.display_name ?? ""}</td>
                  <td title={formatDate(item.item_date)}>{formatDate(item.item_date)}</td>
                  <td title={item.delivery_note ?? undefined}>{item.delivery_note ?? ""}</td>
                  <td className="miscellaneous-tools-remarks"><span title={item.remarks ?? undefined}>{item.remarks ?? ""}</span></td>
                  <td title={item.supplier ?? undefined}>{item.supplier ?? ""}</td>
                  <td title={item.invoice_number ?? undefined}>{item.invoice_number ?? ""}</td>
                  <td className="miscellaneous-tools-status-cell">
                    <ToolMaterialInlineStatusSelect
                      disabled={savingStatusItemId !== null}
                      item={item}
                      saving={savingStatusItemId === item.id}
                      onChange={(status) => changeStatus(item, status)}
                    />
                  </td>
                </tr>
              )) : (
                <tr>
                  <td className="miscellaneous-tools-empty" colSpan={toolMaterialColumns.length}>
                    {searchTerm.trim() || filtersActive ? "Keine Treffer gefunden." : "Noch keine Einträge vorhanden."}
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
          historicalEmployee={null}
          people={people}
          peopleError={peopleError}
          peopleLoading={peopleLoading}
          requireBegNumber
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
            historicalEmployee={selectedItem.employee}
            people={people}
            peopleError={peopleError}
            peopleLoading={peopleLoading}
            requireBegNumber={false}
            onChange={(values) => updateDraft(selectedItem.id, values)}
          />
        )}
      </EntityDetailDrawer>
    </section>
  );
}

function ToolMaterialFields({
  draft,
  historicalEmployee,
  people,
  peopleError,
  peopleLoading,
  requireBegNumber,
  onChange,
}: {
  draft: ToolMaterialDraft;
  historicalEmployee: ToolMaterialEmployee | null;
  people: Person[];
  peopleError: string | null;
  peopleLoading: boolean;
  requireBegNumber: boolean;
  onChange: (values: Partial<ToolMaterialDraft>) => void;
}) {
  return (
    <div className="tool-material-form-grid">
      <label>
        <span>BEG-Nr.</span>
        <input
          required={requireBegNumber}
          value={draft.beg_number}
          onChange={(event) => onChange({ beg_number: event.target.value })}
        />
      </label>
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
      <ToolMaterialEmployeeSelect
        error={peopleError}
        historicalEmployee={historicalEmployee}
        loading={peopleLoading}
        people={people}
        value={draft.employee_id}
        onChange={(value) => onChange({
          employee_id: value,
          status: getSuggestedToolMaterialStatus(draft.status, value),
        })}
      />
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
        <span>Status</span>
        <select
          value={draft.status}
          onChange={(event) => onChange(getToolMaterialStatusChange(event.target.value as ToolMaterialStatus))}
        >
          {toolMaterialStatusOptions.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
    </div>
  );
}

function ToolMaterialEmployeeSelect({
  value,
  people,
  historicalEmployee,
  loading,
  error,
  onChange,
}: {
  value: string;
  people: Person[];
  historicalEmployee: ToolMaterialEmployee | null;
  loading: boolean;
  error: string | null;
  onChange: (value: string) => void;
}) {
  const labelId = useId();
  const options = useMemo(
    () => buildToolMaterialEmployeeOptions(people, historicalEmployee),
    [historicalEmployee, people],
  );
  return (
    <div className="tool-material-field">
      <span id={labelId}>Mitarbeiter</span>
      <DashboardNotePicker
        emptyText="Kein Mitarbeiter gefunden"
        error={error}
        errorText="Mitarbeiter konnten nicht geladen werden."
        labelId={labelId}
        listLabel="Mitarbeiter auswählen"
        loading={loading}
        loadingText="Mitarbeiter werden geladen..."
        options={options}
        searchLabel="Mitarbeiter suchen"
        searchPlaceholder="Mitarbeiter suchen"
        value={value}
        onChange={onChange}
      />
    </div>
  );
}

function ToolMaterialInlineStatusSelect({
  disabled,
  item,
  saving,
  onChange,
}: {
  disabled: boolean;
  item: ToolMaterialItem;
  saving: boolean;
  onChange: (status: ToolMaterialStatus) => Promise<void>;
}) {
  const popupId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState<{
    bottom?: number;
    left: number;
    top?: number;
    width: number;
  } | null>(null);
  const presentation = getToolMaterialStatusPresentation(item.status);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }
    const updatePosition = () => {
      if (triggerRef.current) {
        setPosition(getToolMaterialStatusPopupPosition(triggerRef.current));
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (!target || triggerRef.current?.contains(target) || popupRef.current?.contains(target)) {
        return;
      }
      setIsOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    };
    updatePosition();
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [isOpen]);

  return (
    <div className="tool-material-inline-status">
      <button
        aria-controls={isOpen ? popupId : undefined}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label={`Status für ${item.designation}: ${presentation.label}`}
        className={`tool-material-inline-status-trigger ${presentation.badgeClass}`}
        disabled={disabled}
        ref={triggerRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setIsOpen((current) => !current);
        }}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <span>{presentation.label}</span>
        {saving ? (
          <LoaderCircle aria-label="Status wird gespeichert" className="tool-material-status-spinner" size={12} />
        ) : (
          <ChevronDown aria-hidden="true" size={12} />
        )}
      </button>
      {isOpen && position && typeof document !== "undefined" ? createPortal(
        <div
          aria-label={`Status für ${item.designation} auswählen`}
          className="tool-material-inline-status-popup"
          id={popupId}
          ref={popupRef}
          role="listbox"
          style={position}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {toolMaterialStatusOptions.map((option) => (
            <button
              aria-selected={option.value === item.status}
              className={option.value === item.status ? "is-selected" : undefined}
              key={option.value}
              role="option"
              type="button"
              onClick={() => {
                setIsOpen(false);
                void onChange(option.value);
              }}
            >
              <span className={`tool-material-status-swatch ${option.badgeClass}`} />
              <span>{option.label}</span>
              {option.value === item.status ? <Check aria-hidden="true" size={13} /> : null}
            </button>
          ))}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

function getToolMaterialStatusPopupPosition(trigger: HTMLElement) {
  const margin = 8;
  const gap = 4;
  const width = 142;
  const popupHeight = 106;
  const rect = trigger.getBoundingClientRect();
  const openAbove = window.innerHeight - rect.bottom - gap - margin < popupHeight
    && rect.top > popupHeight;
  const horizontalPosition = {
    left: Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin)),
    width,
  };
  return openAbove
    ? { ...horizontalPosition, bottom: window.innerHeight - rect.top + gap }
    : { ...horizontalPosition, top: rect.bottom + gap };
}

function ToolMaterialFilterHeader({
  column,
  filter,
  options,
  isOpen,
  isSorted,
  sortDirection,
  onChange,
  onReset,
  onSort,
  onOpenChange,
}: {
  column: ToolMaterialColumn;
  filter: ToolMaterialColumnFilter | undefined;
  options: ToolMaterialFilterOption[];
  isOpen: boolean;
  isSorted: boolean;
  sortDirection: ToolMaterialSortDirection;
  onChange: (filter: ToolMaterialColumnFilter) => void;
  onReset: () => void;
  onSort: (direction: ToolMaterialSortDirection) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{
    bottom?: number;
    left: number;
    maxHeight: number;
    top?: number;
    width: number;
  } | null>(null);
  const activeFilter = isToolMaterialColumnFilterActive(filter);
  const query = filter?.query ?? "";
  const visibleOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("de-DE");
    if (!normalizedQuery) {
      return options;
    }
    return options.filter((option) => option.label.toLocaleLowerCase("de-DE").includes(normalizedQuery));
  }, [options, query]);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }
    const updatePosition = () => {
      if (triggerRef.current) {
        setPosition(getToolMaterialFilterPopupPosition(triggerRef.current));
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (!target || triggerRef.current?.contains(target) || popupRef.current?.contains(target)) {
        return;
      }
      onOpenChange(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onOpenChange(false);
        triggerRef.current?.focus();
      }
    };
    updatePosition();
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [isOpen, onOpenChange]);

  function toggleValue(value: string) {
    const selectedValues = filter?.values ?? [];
    const values = selectedValues.includes(value)
      ? selectedValues.filter((selectedValue) => selectedValue !== value)
      : [...selectedValues, value];
    onChange({ ...filter, values });
  }

  return (
    <th>
      <button
        aria-expanded={isOpen}
        aria-label={`${column.label} filtern und sortieren`}
        className={`tool-material-filter-trigger${activeFilter || isSorted ? " is-active" : ""}`}
        ref={triggerRef}
        type="button"
        onClick={() => onOpenChange(!isOpen)}
      >
        <span>{column.label}</span>
        <ListFilter aria-hidden="true" size={13} />
      </button>
      {isOpen && position && typeof document !== "undefined" ? createPortal(
        <div
          className="tool-material-filter-popup"
          ref={popupRef}
          role="dialog"
          style={position}
        >
          <div className="tool-material-filter-sort-actions">
            <button
              className={isSorted && sortDirection === "asc" ? "is-active" : undefined}
              type="button"
              onClick={() => onSort("asc")}
            >
              <ArrowDownAZ aria-hidden="true" size={14} />
              <span>Aufsteigend</span>
            </button>
            <button
              className={isSorted && sortDirection === "desc" ? "is-active" : undefined}
              type="button"
              onClick={() => onSort("desc")}
            >
              <ArrowUpAZ aria-hidden="true" size={14} />
              <span>Absteigend</span>
            </button>
          </div>

          {column.type === "text" ? (
            <label className="tool-material-filter-input">
              <span>Textsuche</span>
              <input
                autoFocus
                placeholder={`${column.label} durchsuchen`}
                type="search"
                value={query}
                onChange={(event) => onChange({ ...filter, query: event.target.value })}
              />
            </label>
          ) : null}

          {column.type === "date" ? (
            <div className="tool-material-filter-range">
              <label>
                <span>Von</span>
                <input
                  type="date"
                  value={filter?.dateFrom ?? ""}
                  onChange={(event) => onChange({ ...filter, dateFrom: event.target.value })}
                />
              </label>
              <label>
                <span>Bis</span>
                <input
                  type="date"
                  value={filter?.dateTo ?? ""}
                  onChange={(event) => onChange({ ...filter, dateTo: event.target.value })}
                />
              </label>
            </div>
          ) : null}

          <div className="tool-material-filter-values" role="group" aria-label={`Werte für ${column.label}`}>
            <span className="tool-material-filter-values-title">Vorhandene Werte</span>
            {visibleOptions.length ? visibleOptions.map((option) => (
              <label key={option.value}>
                <input
                  checked={(filter?.values ?? []).includes(option.value)}
                  type="checkbox"
                  onChange={() => toggleValue(option.value)}
                />
                <span title={option.label}>{option.label}</span>
              </label>
            )) : <p>Keine Werte gefunden.</p>}
          </div>

          <button
            className="tool-material-filter-reset"
            disabled={!activeFilter}
            type="button"
            onClick={onReset}
          >
            <RotateCcw aria-hidden="true" size={13} />
            <span>Filter zurücksetzen</span>
          </button>
        </div>,
        document.body,
      ) : null}
    </th>
  );
}

function getToolMaterialFilterPopupPosition(trigger: HTMLElement) {
  const margin = 8;
  const gap = 4;
  const width = Math.min(290, window.innerWidth - margin * 2);
  const preferredHeight = 430;
  const rect = trigger.getBoundingClientRect();
  const availableBelow = window.innerHeight - rect.bottom - gap - margin;
  const availableAbove = rect.top - gap - margin;
  const openAbove = availableBelow < 220 && availableAbove > availableBelow;
  const maxHeight = Math.max(180, Math.min(preferredHeight, openAbove ? availableAbove : availableBelow));
  const horizontalPosition = {
    left: Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin)),
    maxHeight,
    width,
  };
  return openAbove
    ? { ...horizontalPosition, bottom: window.innerHeight - rect.top + gap }
    : { ...horizontalPosition, top: rect.bottom + gap };
}

function toToolMaterialDraft(item: ToolMaterialItem): ToolMaterialDraft {
  return {
    beg_number: item.beg_number ?? "",
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
    status: item.status,
  };
}

function toToolMaterialDrafts(items: ToolMaterialItem[]): Record<number, ToolMaterialDraft> {
  return Object.fromEntries(items.map((item) => [item.id, toToolMaterialDraft(item)]));
}

function toToolMaterialPayload(draft: ToolMaterialDraft): ToolMaterialItemCreate {
  return {
    beg_number: draft.beg_number.trim(),
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
    status: draft.status,
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
