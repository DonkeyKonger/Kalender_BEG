import { useEffect, useState } from "react";

import { api } from "../lib/api";
import type { SiteGeocodeSearchResult } from "../types/site";

type AddressSearchProps = {
  className?: string;
  disabled?: boolean;
  inputId?: string;
  inputName?: string;
  successMessage?: string;
  onSelect: (result: SiteGeocodeSearchResult) => void;
};

export function AddressSearch({
  className = "",
  disabled = false,
  inputId,
  inputName,
  successMessage = "Standort aus Vorschlag uebernommen und geprueft.",
  onSelect,
}: AddressSearchProps) {
  const [addressSearch, setAddressSearch] = useState("");
  const [addressResults, setAddressResults] = useState<SiteGeocodeSearchResult[]>([]);
  const [isSearchingAddress, setIsSearchingAddress] = useState(false);
  const [addressSearchMessage, setAddressSearchMessage] = useState<string | null>(null);
  const [selectedGeocodeResult, setSelectedGeocodeResult] = useState<SiteGeocodeSearchResult | null>(null);

  useEffect(() => {
    const query = addressSearch.trim();
    if (selectedGeocodeResult && query === selectedGeocodeResult.label) {
      setAddressResults([]);
      setIsSearchingAddress(false);
      return;
    }
    if (query.length < 3 || disabled) {
      setAddressResults([]);
      setIsSearchingAddress(false);
      setAddressSearchMessage(null);
      return;
    }

    let cancelled = false;
    setIsSearchingAddress(true);
    setAddressSearchMessage(null);
    const timer = window.setTimeout(() => {
      api
        .searchSiteAddress(query)
        .then((results) => {
          if (cancelled) {
            return;
          }
          setAddressResults(results);
          setAddressSearchMessage(results.length ? null : "Keine passende Adresse gefunden. Bitte Eingabe pruefen oder genauer formulieren.");
        })
        .catch(() => {
          if (!cancelled) {
            setAddressResults([]);
            setAddressSearchMessage("Adresssuche aktuell nicht verfuegbar.");
          }
        })
        .finally(() => {
          if (!cancelled) {
            setIsSearchingAddress(false);
          }
        });
    }, 400);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [addressSearch, disabled, selectedGeocodeResult]);

  function applyGeocodeResult(result: SiteGeocodeSearchResult) {
    setSelectedGeocodeResult(result);
    onSelect(result);
    setAddressSearch("");
    setAddressResults([]);
    setIsSearchingAddress(false);
    setAddressSearchMessage(successMessage);
    (document.activeElement as HTMLElement | null)?.blur();
  }

  return (
    <label className={`address-field site-address-search${className ? ` ${className}` : ""}`}>
      <span>Adresse suchen</span>
      <input
        aria-label="Adresse suchen"
        autoCapitalize="none"
        autoComplete="new-password"
        autoCorrect="off"
        disabled={disabled}
        id={inputId}
        inputMode="search"
        name={inputName}
        placeholder="z. B. Moorburger Str. 16, 21079 Hamburg"
        spellCheck={false}
        value={addressSearch}
        onChange={(event) => {
          setSelectedGeocodeResult(null);
          setAddressSearch(event.target.value);
        }}
      />
      {isSearchingAddress && <small>Adresse wird gesucht...</small>}
      {addressSearchMessage && <small>{addressSearchMessage}</small>}
      {addressResults.length > 0 && (
        <div className="site-address-results" role="listbox">
          {addressResults.map((result) => (
            <button
              key={`${result.latitude}-${result.longitude}-${result.label}`}
              type="button"
              onClick={() => applyGeocodeResult(result)}
            >
              <strong>{result.label}</strong>
              <span>{formatGeocodeMeta(result)}</span>
            </button>
          ))}
        </div>
      )}
    </label>
  );
}

export function AddressDisplayItem({ label, value, wide = false }: { label: string; value: string | null | undefined; wide?: boolean }) {
  return (
    <div className={`site-address-display-item${wide ? " is-wide" : ""}`}>
      <span>{label}</span>
      <strong>{value || "—"}</strong>
    </div>
  );
}

export function formatGeocodeMeta(result: SiteGeocodeSearchResult): string {
  const place = [result.postal_code, result.city].filter(Boolean).join(" ");
  const precision = result.street || result.house_number ? "Adresse" : "Ort";
  return [place, precision].filter(Boolean).join(" · ");
}
