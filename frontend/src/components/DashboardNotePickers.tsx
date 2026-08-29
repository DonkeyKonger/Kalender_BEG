import { Check, ChevronDown, Search } from "lucide-react";
import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type {
  DashboardNote,
  DashboardNoteUser,
  OperationalAbsenceProjectManager,
} from "../lib/api";
import { filterPickerOptions } from "../lib/pickerSearch";
import { getDashboardNotePickerNavigationIndex } from "../lib/pickerKeyboard";
import type { Person } from "../types/person";

type DashboardNoteSiteOption = {
  id: number;
  site_number: string | null;
  name: string;
};

export type DashboardNotePickerOption = {
  value: string;
  label: string;
  searchText: string;
  groupLabel?: string;
};

type DashboardNotePickerPopupPosition = {
  bottom?: number;
  left: number;
  maxHeight: number;
  top?: number;
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

export function DashboardOperationalAbsenceProjectManagerSelect({
  value,
  people,
  loading,
  error,
  labelId,
  onChange,
}: {
  value: string;
  people: OperationalAbsenceProjectManager[];
  loading: boolean;
  error: string | null;
  labelId: string;
  onChange: (value: string) => void;
}) {
  const options = useMemo(() => people
    .slice()
    .sort((first, second) => (
      first.display_name.localeCompare(second.display_name, "de", { sensitivity: "base" })
      || first.id - second.id
    ))
    .map((person) => ({
      value: String(person.id),
      label: person.short_code
        ? `${person.short_code} · ${person.display_name}`
        : person.display_name,
      searchText: `${person.short_code} ${person.display_name}`,
    })), [people]);

  return (
    <DashboardNotePicker
      emptyOptionLabel="Bitte auswählen"
      emptyText="Kein Projektleiter gefunden"
      error={error}
      errorText="Projektleiter konnten nicht geladen werden."
      labelId={labelId}
      listLabel="Projektleiter auswählen"
      loading={loading}
      loadingText="Projektleiter werden geladen..."
      options={options}
      searchLabel="Projektleiter suchen"
      searchPlaceholder="Projektleiter suchen…"
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

export function DashboardNotePicker({
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
  includeEmptyOption = true,
  searchable = true,
  disabled = false,
  onChange,
}: {
  value: string;
  options: DashboardNotePickerOption[];
  loading: boolean;
  error: string | null;
  labelId: string;
  listLabel: string;
  searchLabel?: string;
  searchPlaceholder?: string;
  loadingText: string;
  errorText: string;
  emptyText: string;
  emptyOptionLabel?: string;
  includeEmptyOption?: boolean;
  searchable?: boolean;
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
  const [activeOptionValue, setActiveOptionValue] = useState<string | null>(null);
  const [popupPosition, setPopupPosition] = useState<DashboardNotePickerPopupPosition | null>(null);
  const selectedOption = options.find((option) => option.value === value) ?? null;
  const selectedLabel = selectedOption?.label ?? emptyOptionLabel;
  const filteredOptions = useMemo(
    () => searchable ? filterPickerOptions(options, query) : options,
    [options, query, searchable],
  );
  const keyboardOptions = useMemo(
    () => [
      ...(includeEmptyOption ? [{ value: "", label: emptyOptionLabel }] : []),
      ...filteredOptions,
    ],
    [emptyOptionLabel, filteredOptions, includeEmptyOption],
  );
  const activeOptionIndex = keyboardOptions.findIndex((option) => option.value === activeOptionValue);
  const activeOptionId = activeOptionIndex >= 0 ? `${listboxId}-option-${activeOptionIndex}` : undefined;
  const popupPreferredHeight = searchable
    ? 330
    : Math.min(330, (options.length + (includeEmptyOption ? 1 : 0)) * 34 + 2);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const updatePosition = () => {
      if (triggerRef.current) {
        setPopupPosition(getDashboardNotePickerPopupPosition(triggerRef.current, popupPreferredHeight));
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
    const focusFrame = window.requestAnimationFrame(() => {
      if (searchable) {
        searchRef.current?.focus();
        return;
      }
      const selected = popupRef.current?.querySelector<HTMLButtonElement>(
        '.dashboard-note-picker-option[aria-selected="true"]',
      );
      const first = popupRef.current?.querySelector<HTMLButtonElement>(
        ".dashboard-note-picker-option",
      );
      (selected ?? first)?.focus();
    });
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
  }, [isOpen, popupPreferredHeight, searchable]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    if (activeOptionIndex >= 0) {
      return;
    }
    setActiveOptionValue(
      keyboardOptions.some((option) => option.value === value)
        ? value
        : (keyboardOptions[0]?.value ?? null),
    );
  }, [activeOptionIndex, isOpen, keyboardOptions, value]);

  useEffect(() => {
    if (!isOpen || activeOptionId === undefined) {
      return;
    }
    document.getElementById(activeOptionId)?.scrollIntoView({ block: "nearest" });
  }, [activeOptionId, isOpen]);

  const closeAndFocusTrigger = () => {
    setIsOpen(false);
    setQuery("");
    setActiveOptionValue(null);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const selectOption = (optionValue: string) => {
    onChange(optionValue);
    closeAndFocusTrigger();
  };

  const openPicker = () => {
    if (triggerRef.current) {
      setPopupPosition(getDashboardNotePickerPopupPosition(triggerRef.current, popupPreferredHeight));
    }
    setQuery("");
    setActiveOptionValue(
      keyboardOptions.some((option) => option.value === value)
        ? value
        : (keyboardOptions[0]?.value ?? null),
    );
    setIsOpen(true);
  };

  return (
    <div className="dashboard-note-picker">
      <button
        aria-controls={isOpen ? listboxId : undefined}
        aria-activedescendant={isOpen ? activeOptionId : undefined}
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
            setActiveOptionValue(null);
            return;
          }
          openPicker();
        }}
        onKeyDown={(event) => {
          if (!isOpen && (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            openPicker();
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
              className={`dashboard-note-picker-popup${searchable ? "" : " is-searchless"}`}
              ref={popupRef}
              style={popupPosition}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  closeAndFocusTrigger();
                  return;
                }
                if (event.key === "Enter" && activeOptionValue !== null) {
                  event.preventDefault();
                  event.stopPropagation();
                  selectOption(activeOptionValue);
                  return;
                }
                if (
                  event.key === " "
                  && event.target instanceof HTMLButtonElement
                  && event.target.classList.contains("dashboard-note-picker-option")
                ) {
                  event.preventDefault();
                  event.target.click();
                  return;
                }
                if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                  return;
                }
                if (
                  event.target === searchRef.current
                  && event.key !== "ArrowDown"
                  && event.key !== "ArrowUp"
                ) {
                  return;
                }
                const nextIndex = getDashboardNotePickerNavigationIndex(
                  activeOptionIndex,
                  keyboardOptions.length,
                  event.key,
                );
                if (nextIndex === null) {
                  return;
                }
                event.preventDefault();
                event.stopPropagation();
                setActiveOptionValue(keyboardOptions[nextIndex]?.value ?? null);
                if (event.target !== searchRef.current) {
                  document.getElementById(`${listboxId}-option-${nextIndex}`)?.focus();
                }
              }}
            >
              {searchable ? (
                <div className="dashboard-note-picker-search">
                  <Search aria-hidden="true" size={14} />
                  <input
                    aria-label={searchLabel}
                    aria-activedescendant={activeOptionId}
                    aria-controls={listboxId}
                    autoComplete="off"
                    placeholder={searchPlaceholder}
                    ref={searchRef}
                    type="search"
                    value={query}
                    onChange={(event) => {
                      const nextQuery = event.target.value;
                      const nextOptions = filterPickerOptions(options, nextQuery);
                      setQuery(nextQuery);
                      setActiveOptionValue(nextOptions[0]?.value ?? (includeEmptyOption ? "" : null));
                    }}
                  />
                </div>
              ) : null}
              <div aria-label={listLabel} className="dashboard-note-picker-options" id={listboxId} role="listbox">
                {includeEmptyOption ? (
                  <button
                    id={`${listboxId}-option-0`}
                    aria-selected={value === ""}
                    className={`dashboard-note-picker-option${value === "" ? " is-selected" : ""}${activeOptionValue === "" ? " is-active" : ""}`}
                    role="option"
                    type="button"
                    onFocus={() => setActiveOptionValue("")}
                    onMouseMove={() => setActiveOptionValue("")}
                    onClick={() => selectOption("")}
                  >
                    <span className="dashboard-note-picker-option-check" aria-hidden="true">
                      {value === "" ? <Check size={13} /> : null}
                    </span>
                    <span>{emptyOptionLabel}</span>
                  </button>
                ) : null}
                {loading ? <p className="dashboard-note-picker-option-status">{loadingText}</p> : null}
                {error ? <p className="dashboard-note-picker-option-status is-error">{errorText}</p> : null}
                {!loading && !error
                  ? filteredOptions.map((option, index) => {
                      const isSelected = value === option.value;
                      const showGroup = option.groupLabel && option.groupLabel !== filteredOptions[index - 1]?.groupLabel;
                      return (
                        <Fragment key={option.value}>
                          {showGroup ? <div className="dashboard-note-picker-group">{option.groupLabel}</div> : null}
                          <button
                            id={`${listboxId}-option-${index + (includeEmptyOption ? 1 : 0)}`}
                            aria-selected={isSelected}
                            className={`dashboard-note-picker-option${isSelected ? " is-selected" : ""}${activeOptionValue === option.value ? " is-active" : ""}`}
                            role="option"
                            title={option.label}
                            type="button"
                            onFocus={() => setActiveOptionValue(option.value)}
                            onMouseMove={() => setActiveOptionValue(option.value)}
                            onClick={() => selectOption(option.value)}
                          >
                            <span className="dashboard-note-picker-option-check" aria-hidden="true">
                              {isSelected ? <Check size={13} /> : null}
                            </span>
                            <span>{option.label}</span>
                          </button>
                        </Fragment>
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

function getDashboardNotePickerPopupPosition(
  trigger: HTMLElement,
  preferredHeight = 330,
): DashboardNotePickerPopupPosition {
  const gap = 5;
  const margin = 8;
  const rect = trigger.getBoundingClientRect();
  const width = Math.min(Math.max(rect.width, 320), window.innerWidth - margin * 2);
  const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
  const availableBelow = window.innerHeight - rect.bottom - gap - margin;
  const availableAbove = rect.top - gap - margin;
  const openAbove = availableBelow < preferredHeight && availableAbove > availableBelow;
  const availableHeight = openAbove ? availableAbove : availableBelow;
  const maxHeight = Math.max(120, Math.min(preferredHeight, availableHeight));
  if (openAbove) {
    return {
      bottom: Math.max(margin, window.innerHeight - rect.top + gap),
      left,
      maxHeight,
      width,
    };
  }
  return { left, maxHeight, top: rect.bottom + gap, width };
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
