import { useEffect, useId, useMemo, useState } from "react";
import { Car, Search, X } from "lucide-react";
import {
  formatDrivingRoute, getDrivingRoute, searchRoutePlaces,
  type DrivingRoute, type RouteField, type RouteFields, type RoutePlace,
} from "../lib/mapRouting";

const ISOLATED_LOCAL_TEST = import.meta.env.VITE_LOCAL_TEST_MODE === "isolated";

export function MapRoutePlanner({ fields, places, loading, onChange }: {
  fields: RouteFields;
  places: RoutePlace[];
  loading: boolean;
  onChange: (index: 0 | 1, field: RouteField) => void;
}) {
  const [route, setRoute] = useState<{ start: RoutePlace; end: RoutePlace; value: DrivingRoute } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const start = fields[0].place;
  const end = fields[1].place;

  useEffect(() => {
    setError(null);
    setRoute(null);
    if (!start || !end || ISOLATED_LOCAL_TEST) return;
    const controller = new AbortController();
    getDrivingRoute(start, end, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setRoute({ start, end, value }); })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "Fahrstrecke konnte nicht berechnet werden.");
      });
    return () => controller.abort();
  }, [start, end, retry]);

  const currentRoute = route?.start === start && route?.end === end ? route.value : null;
  return (
    <section className="map-route-planner" aria-label="Route abschätzen">
      <RouteAddressField label="Start" field={fields[0]} places={places} loading={loading} onChange={(field) => onChange(0, field)} />
      <RouteAddressField label="Ziel" field={fields[1]} places={places} loading={loading} onChange={(field) => onChange(1, field)} />
      <div className="map-route-summary">
        <div className="map-route-result" role="status" aria-live="polite" title="Geschätzte Pkw-Fahrzeit ohne Live-Verkehr">
          <Car size={17} aria-hidden="true" />
          {!start || !end ? <span>Start und Ziel wählen.</span>
            : ISOLATED_LOCAL_TEST ? <span>Im isolierten Testkalender ist die Online-Routenberechnung gesperrt.</span>
              : error ? <span className="map-route-error">{error} <button type="button" onClick={() => setRetry((value) => value + 1)}>Erneut versuchen</button></span>
              : currentRoute ? <strong>{formatDrivingRoute(currentRoute)}</strong>
                : <span>Fahrstrecke wird berechnet…</span>}
        </div>
      </div>
    </section>
  );
}

function RouteAddressField({ label, field, places, loading, onChange }: {
  label: string;
  field: RouteField;
  places: RoutePlace[];
  loading: boolean;
  onChange: (field: RouteField) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const matches = useMemo(() => searchRoutePlaces(places, field.place ? "" : field.query), [places, field]);
  const options = matches.slice(0, 40);
  const activeIndex = Math.min(active, options.length - 1);

  function select(place: RoutePlace) {
    onChange({ query: place.name, place });
    setOpen(false);
    setActive(0);
  }

  useEffect(() => {
    if (open && activeIndex >= 0) document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, id, open]);

  return (
    <div className="map-route-field" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
    }}>
      <label htmlFor={id}>{label}</label>
      <div className="map-route-input">
        <Search size={14} aria-hidden="true" />
        <input
          id={id} role="combobox" autoComplete="off" value={field.query}
          placeholder="Monteur / Baustelle / Adresse …" title={field.place?.address || undefined}
          aria-expanded={open} aria-autocomplete="list" aria-controls={`${id}-options`}
          aria-activedescendant={open && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
          onFocus={(event) => { setOpen(true); setActive(0); event.currentTarget.select(); }}
          onChange={(event) => { onChange({ query: event.target.value, place: null }); setOpen(true); setActive(0); }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (!open) { setOpen(true); setActive(0); }
              else setActive(Math.max(0, Math.min(options.length - 1, activeIndex + (event.key === "ArrowDown" ? 1 : -1))));
            } else if (event.key === "Enter" && open && options[activeIndex]) {
              event.preventDefault(); select(options[activeIndex]);
            } else if (event.key === "Escape") setOpen(false);
          }}
        />
        {field.query && <button type="button" className="map-route-clear" aria-label={`${label} löschen`} onClick={() => {
          onChange({ query: "", place: null }); setActive(0); setOpen(false);
          document.getElementById(id)?.focus();
        }}><X size={14} aria-hidden="true" /></button>}
      </div>
      {open && <div className="map-route-options" id={`${id}-options`} role="listbox" aria-label={`${label} auswählen`}>
        {options.map((place, index) => (
          <button
            type="button" role="option" tabIndex={-1} id={`${id}-option-${index}`} key={place.key}
            aria-selected={index === activeIndex} className={index === activeIndex ? "is-active" : ""}
            onMouseDown={(event) => event.preventDefault()} onClick={() => select(place)}
          >
            <span className="map-route-option-title"><strong>{place.name}</strong><span>{place.kind === "person" ? "Person" : "Baustelle"}</span></span>
            <small>{place.address || "Hinterlegter Kartenpunkt"}</small>
          </button>
        ))}
        {loading && <p>Adressen werden geladen…</p>}
        {!loading && options.length === 0 && <p>Keine passende Kartenadresse. Bitte Name, Baustellennummer oder hinterlegte Adresse suchen.</p>}
        {matches.length > options.length && <p>Weitere Treffer – Suche bitte eingrenzen.</p>}
      </div>}
    </div>
  );
}
