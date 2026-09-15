import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import type { MeasurementItem } from "../types/site";
import { filterMeasurementOfferPositions } from "../lib/measurementOfferPositions";
import "./MeasurementOfferPositions.css";

type Props = {
  name: string;
  items: MeasurementItem[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onClose: () => void;
};

export function MeasurementOfferPositions({ name, items, loading, error, onRetry, onClose }: Props) {
  const [query, setQuery] = useState("");
  const all = useMemo(() => filterMeasurementOfferPositions(items, ""), [items]);
  const matches = useMemo(() => filterMeasurementOfferPositions(all, query), [all, query]);
  return <section className="measurement-offer-positions" aria-label="Angebot anzeigen">
    <header>
      <div><h2>Angebot</h2><p>{name}</p></div>
      <button type="button" aria-label="Angebot schließen" onClick={onClose}><X size={18} aria-hidden="true" /></button>
    </header>
    <label className="measurement-offer-search">
      <Search size={16} aria-hidden="true" />
      <input autoFocus type="search" aria-label="Angebotspositionen durchsuchen" placeholder="Position oder Beschreibung suchen…"
        value={query} onChange={event => setQuery(event.target.value)} />
    </label>
    <div className="measurement-offer-list" aria-busy={loading}>
      {loading ? <p role="status">Positionen werden geladen…</p> : error ? <div role="alert"><p>{error}</p><button type="button" onClick={onRetry}>Erneut versuchen</button></div>
        : matches.length ? <table>
          <thead><tr><th scope="col">Pos.-Nr.</th><th scope="col">Beschreibung</th><th scope="col">Einheit</th></tr></thead>
          <tbody>{matches.map(item => <tr key={item.id}><th scope="row">{item.position}</th><td>{item.description}</td><td>{item.unit || "–"}</td></tr>)}</tbody>
        </table> : <p role="status">{all.length ? "Keine passenden Positionen gefunden." : "Keine Angebotspositionen vorhanden."}</p>}
    </div>
    {!loading && !error ? <footer aria-live="polite">{matches.length} von {all.length} Positionen</footer> : null}
  </section>;
}
