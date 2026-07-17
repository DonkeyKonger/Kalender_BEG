import { ArrowDownAZ, ArrowUpAZ, LoaderCircle, Plus, Save, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";

import { DashboardNotePicker } from "./DashboardNotePickers";
import { EntityDetailDrawer } from "./EntityDetailDrawer";
import { ApiError, api } from "../lib/api";
import type {
  VehicleDatabaseItem,
  VehicleDatabaseOptions,
  VehicleDatabasePayload,
  VehicleDatabaseSortDirection,
  VehicleDatabaseSortField,
} from "../types/vehicleDatabase";

type VehicleDraft = {
  licensePlate: string;
  manufacturer: string;
  employeeId: string;
  ctrackVehicleId: string;
};

type DrawerState = { mode: "new" } | { mode: "edit"; vehicleId: number } | null;

const EMPTY_DRAFT: VehicleDraft = {
  licensePlate: "",
  manufacturer: "",
  employeeId: "",
  ctrackVehicleId: "",
};

const COLUMNS: Array<{ key: VehicleDatabaseSortField; label: string }> = [
  { key: "license_plate", label: "Kennzeichen" },
  { key: "manufacturer", label: "Hersteller" },
  { key: "employee", label: "Monteur" },
  { key: "ctrack", label: "C-Track-Verknüpfung" },
];

export function VehicleDatabasePanel() {
  const [items, setItems] = useState<VehicleDatabaseItem[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [sortBy, setSortBy] = useState<VehicleDatabaseSortField>("license_plate");
  const [sortDirection, setSortDirection] = useState<VehicleDatabaseSortDirection>("asc");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [selectedItem, setSelectedItem] = useState<VehicleDatabaseItem | null>(null);
  const [draft, setDraft] = useState<VehicleDraft>(EMPTY_DRAFT);
  const [options, setOptions] = useState<VehicleDatabaseOptions>({ employees: [], ctrack_vehicles: [] });
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [drawerError, setDrawerError] = useState<string | null>(null);

  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedSearch(searchTerm.trim()), 250);
    return () => window.clearTimeout(handle);
  }, [searchTerm]);

  const loadItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await api.vehicleDatabaseItems({
        search: debouncedSearch,
        sortBy,
        sortDirection,
      }));
    } catch (loadError) {
      setError(apiErrorMessage(loadError, "Fahrzeuge konnten nicht geladen werden."));
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, sortBy, sortDirection]);

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  async function loadOptions() {
    setOptionsLoading(true);
    try {
      setOptions(await api.vehicleDatabaseOptions());
    } catch (loadError) {
      setDrawerError(apiErrorMessage(loadError, "Auswahlwerte konnten nicht geladen werden."));
    } finally {
      setOptionsLoading(false);
    }
  }

  function openCreateDrawer() {
    setDrawer({ mode: "new" });
    setSelectedItem(null);
    setDraft(EMPTY_DRAFT);
    setDrawerError(null);
    void loadOptions();
  }

  async function openEditDrawer(vehicleId: number) {
    setDrawer({ mode: "edit", vehicleId });
    setSelectedItem(null);
    setDrawerError(null);
    setDetailLoading(true);
    setOptionsLoading(true);
    try {
      const [item, loadedOptions] = await Promise.all([
        api.vehicleDatabaseItem(vehicleId),
        api.vehicleDatabaseOptions(),
      ]);
      setSelectedItem(item);
      setOptions(loadedOptions);
      setDraft(toDraft(item));
    } catch (loadError) {
      setDrawerError(apiErrorMessage(loadError, "Fahrzeug konnte nicht geladen werden."));
    } finally {
      setDetailLoading(false);
      setOptionsLoading(false);
    }
  }

  function closeDrawer() {
    if (saving) return;
    setDrawer(null);
    setSelectedItem(null);
    setDrawerError(null);
  }

  function updateSort(nextSort: VehicleDatabaseSortField) {
    if (sortBy === nextSort) {
      setSortDirection((current) => current === "asc" ? "desc" : "asc");
      return;
    }
    setSortBy(nextSort);
    setSortDirection("asc");
  }

  async function saveVehicle() {
    const payload = toPayload(draft);
    if (!payload.license_plate || !payload.manufacturer) {
      setDrawerError("Kennzeichen und Hersteller sind Pflichtfelder.");
      return;
    }
    setSaving(true);
    setDrawerError(null);
    try {
      if (drawer?.mode === "edit") {
        await api.updateVehicleDatabaseItem(drawer.vehicleId, payload);
      } else {
        await api.createVehicleDatabaseItem(payload);
      }
      closeDrawerAfterSave();
      await loadItems();
    } catch (saveError) {
      setDrawerError(apiErrorMessage(saveError, "Fahrzeug konnte nicht gespeichert werden."));
    } finally {
      setSaving(false);
    }
  }

  async function deleteVehicle() {
    if (!selectedItem || !window.confirm(`Fahrzeug ${selectedItem.license_plate} wirklich löschen?`)) return;
    setSaving(true);
    setDrawerError(null);
    try {
      await api.deleteVehicleDatabaseItem(selectedItem.id);
      closeDrawerAfterSave();
      await loadItems();
    } catch (deleteError) {
      setDrawerError(apiErrorMessage(deleteError, "Fahrzeug konnte nicht gelöscht werden."));
    } finally {
      setSaving(false);
    }
  }

  function closeDrawerAfterSave() {
    setDrawer(null);
    setSelectedItem(null);
    setDrawerError(null);
  }

  return (
    <section className="miscellaneous-tools-panel vehicle-database-panel" role="tabpanel" aria-label="Fahrzeuge">
      <header className="miscellaneous-tools-header">
        <div>
          <h2>Fahrzeuge</h2>
          <p>Zentrale Fahrzeug- und Zuordnungsliste.</p>
        </div>
        <button className="icon-button secondary miscellaneous-tools-add-button" type="button" onClick={openCreateDrawer}>
          <Plus aria-hidden="true" size={17} />
          <span>Fahrzeug hinzufügen</span>
        </button>
      </header>

      <div className="miscellaneous-tools-toolbar vehicle-database-toolbar">
        <label className="overview-search miscellaneous-tools-search">
          <Search aria-hidden="true" size={17} />
          <input
            aria-label="Fahrzeuge suchen"
            placeholder="Fahrzeug suchen"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
          />
        </label>
      </div>

      {error ? <p className="form-error">{error}</p> : null}
      {loading && items.length === 0 ? <div className="matrix-state">Fahrzeuge werden geladen...</div> : null}

      {(!loading || items.length > 0) ? (
        <div className="miscellaneous-tools-table-wrap" aria-busy={loading}>
          <table className="miscellaneous-tools-table vehicle-database-table">
            <colgroup>
              <col className="vehicle-col-license" />
              <col className="vehicle-col-manufacturer" />
              <col className="vehicle-col-employee" />
              <col className="vehicle-col-ctrack" />
            </colgroup>
            <thead>
              <tr>
                {COLUMNS.map((column) => (
                  <th key={column.key}>
                    <button
                      aria-label={`${column.label} sortieren`}
                      className={`vehicle-sort-trigger${sortBy === column.key ? " is-active" : ""}`}
                      type="button"
                      onClick={() => updateSort(column.key)}
                    >
                      <span>{column.label}</span>
                      {sortBy === column.key
                        ? sortDirection === "asc" ? <ArrowDownAZ aria-hidden="true" size={14} /> : <ArrowUpAZ aria-hidden="true" size={14} />
                        : null}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.length > 0 ? items.map((item) => (
                <tr
                  className="miscellaneous-tools-row"
                  key={item.id}
                  tabIndex={0}
                  title="Fahrzeug bearbeiten"
                  onClick={() => void openEditDrawer(item.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      void openEditDrawer(item.id);
                    }
                  }}
                >
                  <td><strong>{item.license_plate}</strong></td>
                  <td>{item.manufacturer}</td>
                  <td>{item.assigned_person?.display_name ?? "Nicht zugewiesen"}</td>
                  <td>{item.ctrack_vehicle?.label ?? "Nicht verknüpft"}</td>
                </tr>
              )) : (
                <tr>
                  <td className="miscellaneous-tools-empty" colSpan={4}>
                    {debouncedSearch ? "Keine Fahrzeuge gefunden." : "Noch keine Fahrzeuge vorhanden."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : null}

      <EntityDetailDrawer
        isOpen={drawer?.mode === "new"}
        title="Fahrzeug hinzufügen"
        subtitle="Fahrzeug und Zuordnungen erfassen"
        onClose={closeDrawer}
        footer={(
          <button className="icon-button" disabled={saving} type="button" onClick={() => void saveVehicle()}>
            {saving ? <LoaderCircle aria-hidden="true" className="spin" size={16} /> : <Plus aria-hidden="true" size={16} />}
            <span>Fahrzeug hinzufügen</span>
          </button>
        )}
      >
        <VehicleFields
          currentVehicleId={null}
          currentEmployee={null}
          draft={draft}
          error={drawerError}
          options={options}
          optionsLoading={optionsLoading}
          onChange={(values) => setDraft((current) => ({ ...current, ...values }))}
        />
      </EntityDetailDrawer>

      <EntityDetailDrawer
        isOpen={drawer?.mode === "edit"}
        title="Fahrzeug bearbeiten"
        subtitle={selectedItem?.license_plate}
        onClose={closeDrawer}
        footer={selectedItem ? (
          <div className="miscellaneous-tools-drawer-footer">
            <button className="icon-button danger" disabled={saving} type="button" onClick={() => void deleteVehicle()}>
              <Trash2 aria-hidden="true" size={16} />
              <span>Löschen</span>
            </button>
            <div className="miscellaneous-tools-drawer-actions">
              <button className="icon-button secondary" disabled={saving} type="button" onClick={closeDrawer}>Abbrechen</button>
              <button className="icon-button secondary" disabled={saving} type="button" onClick={() => void saveVehicle()}>
                {saving ? <LoaderCircle aria-hidden="true" className="spin" size={16} /> : <Save aria-hidden="true" size={16} />}
                <span>Speichern</span>
              </button>
            </div>
          </div>
        ) : undefined}
      >
        {detailLoading ? <div className="matrix-state">Fahrzeug wird geladen...</div> : null}
        {!detailLoading ? (
          <VehicleFields
            currentVehicleId={selectedItem?.id ?? null}
            currentEmployee={selectedItem?.assigned_person ?? null}
            draft={draft}
            error={drawerError}
            options={options}
            optionsLoading={optionsLoading}
            onChange={(values) => setDraft((current) => ({ ...current, ...values }))}
          />
        ) : null}
      </EntityDetailDrawer>
    </section>
  );
}

function VehicleFields({
  currentVehicleId,
  currentEmployee,
  draft,
  error,
  options,
  optionsLoading,
  onChange,
}: {
  currentVehicleId: number | null;
  currentEmployee: VehicleDatabaseItem["assigned_person"];
  draft: VehicleDraft;
  error: string | null;
  options: VehicleDatabaseOptions;
  optionsLoading: boolean;
  onChange: (values: Partial<VehicleDraft>) => void;
}) {
  const employeeLabelId = useId();
  const ctrackLabelId = useId();
  const employeeOptions = useMemo(() => {
    const available = [...options.employees];
    if (currentEmployee && !available.some((employee) => employee.id === currentEmployee.id)) {
      available.push(currentEmployee);
    }
    return available.map((employee) => ({
      value: String(employee.id),
      label: `${employee.display_name}${currentEmployee?.id === employee.id && !options.employees.some((option) => option.id === employee.id) ? " (inaktiv)" : ""}`,
      searchText: `${employee.display_name} ${employee.short_code}`,
    }));
  }, [currentEmployee, options.employees]);
  const ctrackOptions = useMemo(() => options.ctrack_vehicles
    .filter((vehicle) => vehicle.linked_vehicle_id === null || vehicle.linked_vehicle_id === currentVehicleId)
    .map((vehicle) => ({
      value: String(vehicle.id),
      label: vehicle.label,
      searchText: [vehicle.label, vehicle.vehicle_registration, vehicle.fleet_number].filter(Boolean).join(" "),
    })), [currentVehicleId, options.ctrack_vehicles]);

  return (
    <div className="tool-material-form-grid vehicle-form-grid">
      {error ? <p className="form-error vehicle-form-error">{error}</p> : null}
      <label>
        <span>Kennzeichen</span>
        <input
          autoComplete="off"
          required
          value={draft.licensePlate}
          onBlur={() => onChange({ licensePlate: normalizeLicensePlate(draft.licensePlate) })}
          onChange={(event) => onChange({ licensePlate: event.target.value.toUpperCase() })}
        />
      </label>
      <label>
        <span>Hersteller</span>
        <input required value={draft.manufacturer} onChange={(event) => onChange({ manufacturer: event.target.value })} />
      </label>
      <div className="tool-material-field">
        <span id={employeeLabelId}>Monteur</span>
        <DashboardNotePicker
          emptyOptionLabel="Nicht zugewiesen"
          emptyText="Keine aktiven Monteure vorhanden"
          error={null}
          errorText="Monteure konnten nicht geladen werden."
          labelId={employeeLabelId}
          listLabel="Monteur auswählen"
          loading={optionsLoading}
          loadingText="Monteure werden geladen..."
          options={employeeOptions}
          searchLabel="Monteur suchen"
          searchPlaceholder="Monteur suchen..."
          value={draft.employeeId}
          onChange={(employeeId) => onChange({ employeeId })}
        />
      </div>
      <div className="tool-material-field">
        <span id={ctrackLabelId}>C-Track-Verknüpfung</span>
        <DashboardNotePicker
          emptyOptionLabel="Nicht verknüpft"
          emptyText="Keine freien C-Track-Fahrzeuge vorhanden"
          error={null}
          errorText="C-Track-Fahrzeuge konnten nicht geladen werden."
          labelId={ctrackLabelId}
          listLabel="C-Track-Fahrzeug auswählen"
          loading={optionsLoading}
          loadingText="C-Track-Fahrzeuge werden geladen..."
          options={ctrackOptions}
          searchLabel="C-Track-Fahrzeug suchen"
          searchPlaceholder="C-Track-Fahrzeug suchen..."
          value={draft.ctrackVehicleId}
          onChange={(ctrackVehicleId) => onChange({ ctrackVehicleId })}
        />
      </div>
    </div>
  );
}

function toDraft(item: VehicleDatabaseItem): VehicleDraft {
  return {
    licensePlate: item.license_plate,
    manufacturer: item.manufacturer,
    employeeId: item.assigned_person_id === null ? "" : String(item.assigned_person_id),
    ctrackVehicleId: item.ctrack_vehicle_asset_id === null ? "" : String(item.ctrack_vehicle_asset_id),
  };
}

function toPayload(draft: VehicleDraft): VehicleDatabasePayload {
  return {
    license_plate: normalizeLicensePlate(draft.licensePlate),
    manufacturer: draft.manufacturer.trim().replace(/\s+/g, " "),
    assigned_person_id: draft.employeeId ? Number(draft.employeeId) : null,
    ctrack_vehicle_asset_id: draft.ctrackVehicleId ? Number(draft.ctrackVehicleId) : null,
  };
}

function normalizeLicensePlate(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, " ");
}

function apiErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError && error.message ? error.message : fallback;
}
