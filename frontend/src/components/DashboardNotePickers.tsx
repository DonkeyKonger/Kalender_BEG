import { Check, ChevronDown, Search } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { DashboardNote, DashboardNoteUser } from "../lib/api";
import type { Person } from "../types/person";
import type { SiteSummary } from "../types/site";

type DashboardNoteSiteOption = SiteSummary | NonNullable<DashboardNote["site"]>;

type DashboardNotePickerOption = {
  value: string;
  label: string;
  searchText: string;
};

type DashboardNotePickerPopupPosition = {
  left: number;
  maxHeight: number;
  top: number;
  width: number;
};

export function DashboardNoteSiteSelect({
  value,
  sites,
  loading,
  error,
  labelId,
  onChange,
}: {
  value: string;
  sites: DashboardNoteSiteOption[];
  loading: boolean;
  error: string | null;
  labelId: string;
  onChange: (value: string) => void;
}) {
  const options = useMemo(() => sites.map((site) => ({
    value: String(site.id),
    label: formatDashboardNoteSiteOption(site),
    searchText: `${site.site_number ?? ""} ${site.name}`,
  })), [sites]);

  return (
    <DashboardNotePicker
      emptyText="Keine Baustelle gefunden"
      error={error}
      errorText="Baustellen konnten nicht geladen werden."
      labelId={labelId}
      listLabel="Baustelle auswählen"
      loading={loading}
      loadingText="Baustellen werden geladen..."
      options={options}
      searchLabel="Baustelle suchen"
      searchPlaceholder="Baustelle suchen…"
      value={value}
      onChange={onChange}
    />
  );
}

export function DashboardNoteEmployeeSelect({
  value,
  people,
  historicalEmployee,
  loading,
  error,
  labelId,
  onChange,
}: {
  value: string;
  people: Person[];
  historicalEmployee: DashboardNote["employee"];
  loading: boolean;
  error: string | null;
  labelId: string;
  onChange: (value: string) => void;
}) {
  const options = useMemo(() => {
    const activeOptions = people
      .filter(isAssignableDashboardNotePerson)
      .sort(compareDashboardNotePeople)
      .map((person) => ({
        value: String(person.id),
        label: person.display_name,
        searchText: [
          person.first_name,
          person.last_name,
          person.display_name,
          `${person.last_name} ${person.first_name}`,
          person.short_code,
        ].join(" "),
      }));
    if (!historicalEmployee || activeOptions.some((option) => option.value === String(historicalEmployee.id))) {
      return activeOptions;
    }
    return [
      ...activeOptions,
      {
        value: String(historicalEmployee.id),
        label: `${historicalEmployee.display_name}${!loading && !error ? " (nicht mehr aktiv)" : ""}`,
        searchText: `${historicalEmployee.display_name} ${historicalEmployee.short_code}`,
      },
    ];
  }, [error, historicalEmployee, loading, people]);

  return (
    <DashboardNotePicker
      emptyText="Kein Mitarbeiter gefunden"
      error={error}
      errorText="Mitarbeiter konnten nicht geladen werden."
      labelId={labelId}
      listLabel="Monteur auswählen"
      loading={loading}
      loadingText="Mitarbeiter werden geladen..."
      options={options}
      searchLabel="Monteur suchen"
      searchPlaceholder="Monteur suchen…"
      value={value}
      onChange={onChange}
    />
  );
}

export function DashboardNoteShareUserSelect({
  value,
  users,
  historicalUser,
  loading,
  error,
  disabled = false,
  labelId,
  onChange,
}: {
  value: string;
  users: DashboardNoteUser[];
  historicalUser: DashboardNote["shared_with"];
  loading: boolean;
  error: string | null;
  disabled?: boolean;
  labelId: string;
  onChange: (value: string) => void;
}) {
  const options = useMemo(() => {
    const activeOptions = users.map((user) => ({
      value: String(user.id),
      label: user.display_name,
      searchText: `${user.display_name} ${user.username}`,
    }));
    if (!historicalUser || activeOptions.some((option) => option.value === String(historicalUser.id))) {
      return activeOptions;
    }
    return [
      ...activeOptions,
      {
        value: String(historicalUser.id),
        label: historicalUser.display_name,
        searchText: `${historicalUser.display_name} ${historicalUser.username}`,
      },
    ];
  }, [historicalUser, users]);

  return (
    <DashboardNotePicker
      disabled={disabled}
      emptyOptionLabel="Niemand"
      emptyText="Kein Büronutzer gefunden"
      error={error}
      errorText="Büronutzer konnten nicht geladen werden."
      labelId={labelId}
      listLabel="Büronutzer auswählen"
      loading={loading}
      loadingText="Büronutzer werden geladen..."
      options={options}
      searchLabel="Büronutzer suchen"
      searchPlaceholder="Büronutzer suchen…"
      value={value}
      onChange={onChange}
    />
  );
}

function DashboardNotePicker({
  value,
  options,
  loading,
  error,
  labelId,
  listLabel,
  searchLabel,
  searchPlaceholder,
  loadingText,
  errorText,
  emptyText,
  emptyOptionLabel = "Keine Zuordnung",
  disabled = false,
  onChange,
}: {
  value: string;
  options: DashboardNotePickerOption[];
  loading: boolean;
  error: string | null;
  labelId: string;
  listLabel: string;
  searchLabel: string;
  searchPlaceholder: string;
  loadingText: string;
  errorText: string;
  emptyText: string;
  emptyOptionLabel?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const popupId = useId();
  const listboxId = `${popupId}-listbox`;
  const statusId = `${popupId}-status`;
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [popupPosition, setPopupPosition] = useState<DashboardNotePickerPopupPosition | null>(null);
  const selectedOption = options.find((option) => option.value === value) ?? null;
  const selectedLabel = selectedOption?.label ?? emptyOptionLabel;
  const normalizedQuery = query.trim().toLocaleLowerCase("de-DE");
  const filteredOptions = useMemo(() => {
    if (!normalizedQuery) {
      return options;
    }
    return options.filter((option) => (
      option.searchText.toLocaleLowerCase("de-DE").includes(normalizedQuery)
    ));
  }, [normalizedQuery, options]);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const updatePosition = () => {
      if (triggerRef.current) {
        setPopupPosition(getDashboardNotePickerPopupPosition(triggerRef.current));
      }
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (!target || triggerRef.current?.contains(target) || popupRef.current?.contains(target)) {
        return;
      }
      setIsOpen(false);
      setQuery("");
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      setIsOpen(false);
      setQuery("");
      triggerRef.current?.focus();
    };

    updatePosition();
    const focusFrame = window.requestAnimationFrame(() => searchRef.current?.focus());
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [isOpen]);

  const closeAndFocusTrigger = () => {
    setIsOpen(false);
    setQuery("");
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const selectOption = (optionValue: string) => {
    onChange(optionValue);
    closeAndFocusTrigger();
  };

  return (
    <div className="dashboard-note-picker">
      <button
        aria-controls={isOpen ? listboxId : undefined}
        aria-describedby={loading || error ? statusId : undefined}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-labelledby={labelId}
        className={`dashboard-note-picker-trigger${isOpen ? " is-open" : ""}`}
        disabled={disabled}
        ref={triggerRef}
        role="combobox"
        title={selectedLabel}
        type="button"
        onClick={() => {
          if (isOpen) {
            setIsOpen(false);
            setQuery("");
            return;
          }
          if (triggerRef.current) {
            setPopupPosition(getDashboardNotePickerPopupPosition(triggerRef.current));
          }
          setQuery("");
          setIsOpen(true);
        }}
        onKeyDown={(event) => {
          if (!isOpen && (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            if (triggerRef.current) {
              setPopupPosition(getDashboardNotePickerPopupPosition(triggerRef.current));
            }
            setIsOpen(true);
          }
        }}
      >
        <span className="dashboard-note-picker-trigger-label">{selectedLabel}</span>
        <ChevronDown aria-hidden="true" size={15} />
      </button>

      {loading || error ? (
        <small
          className={`dashboard-note-field-status${error ? " is-error" : ""}`}
          id={statusId}
          role="status"
        >
          {error ?? loadingText}
        </small>
      ) : null}

      {isOpen && popupPosition && typeof document !== "undefined"
        ? createPortal(
            <div
              className="dashboard-note-picker-popup"
              ref={popupRef}
              style={popupPosition}
            >
              <div className="dashboard-note-picker-search">
                <Search aria-hidden="true" size={14} />
                <input
                  aria-label={searchLabel}
                  autoComplete="off"
                  placeholder={searchPlaceholder}
                  ref={searchRef}
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <div aria-label={listLabel} className="dashboard-note-picker-options" id={listboxId} role="listbox">
                <button
                  aria-selected={value === ""}
                  className={`dashboard-note-picker-option${value === "" ? " is-selected" : ""}`}
                  role="option"
                  type="button"
                  onClick={() => selectOption("")}
                >
                  <span className="dashboard-note-picker-option-check" aria-hidden="true">
                    {value === "" ? <Check size={13} /> : null}
                  </span>
                  <span>{emptyOptionLabel}</span>
                </button>
                {loading ? <p className="dashboard-note-picker-option-status">{loadingText}</p> : null}
                {error ? <p className="dashboard-note-picker-option-status is-error">{errorText}</p> : null}
                {!loading && !error
                  ? filteredOptions.map((option) => {
                      const isSelected = value === option.value;
                      return (
                        <button
                          aria-selected={isSelected}
                          className={`dashboard-note-picker-option${isSelected ? " is-selected" : ""}`}
                          key={option.value}
                          role="option"
                          title={option.label}
                          type="button"
                          onClick={() => selectOption(option.value)}
                        >
                          <span className="dashboard-note-picker-option-check" aria-hidden="true">
                            {isSelected ? <Check size={13} /> : null}
                          </span>
                          <span>{option.label}</span>
                        </button>
                      );
                    })
                  : null}
                {!loading && !error && filteredOptions.length === 0
                  ? <p className="dashboard-note-picker-option-status">{emptyText}</p>
                  : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function getDashboardNotePickerPopupPosition(trigger: HTMLElement): DashboardNotePickerPopupPosition {
  const gap = 5;
  const margin = 8;
  const preferredHeight = 330;
  const rect = trigger.getBoundingClientRect();
  const width = Math.min(Math.max(rect.width, 320), window.innerWidth - margin * 2);
  const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
  const availableBelow = window.innerHeight - rect.bottom - gap - margin;
  const availableAbove = rect.top - gap - margin;
  const openAbove = availableBelow < 180 && availableAbove > availableBelow;
  const availableHeight = openAbove ? availableAbove : availableBelow;
  const maxHeight = Math.max(120, Math.min(preferredHeight, availableHeight));
  const top = openAbove ? Math.max(margin, rect.top - gap - maxHeight) : rect.bottom + gap;

  return { left, maxHeight, top, width };
}

function formatDashboardNoteSiteOption(site: DashboardNoteSiteOption): string {
  return site.site_number ? `${site.site_number} · ${site.name}` : site.name;
}

function compareDashboardNotePeople(first: Person, second: Person): number {
  return first.last_name.localeCompare(second.last_name, "de", { sensitivity: "base" })
    || first.first_name.localeCompare(second.first_name, "de", { sensitivity: "base" })
    || first.display_name.localeCompare(second.display_name, "de", { sensitivity: "base" })
    || first.id - second.id;
}

function isAssignableDashboardNotePerson(person: Person): boolean {
  if (!person.is_active || person.deleted_at !== null) {
    return false;
  }
  if (person.person_type !== "internal") {
    return true;
  }
  const activeUserRoles = person.user_roles ?? [];
  return activeUserRoles.length === 0 || activeUserRoles.includes("monteur");
}
