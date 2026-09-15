import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { MeasurementItem } from "../types/site";
import { MeasurementOfferPositions } from "./MeasurementOfferPositions";

type Props = { siteId: number; baseId: number | null; name: string | null; onClose: () => void };

export function MeasurementOfferViewer({ siteId, baseId, name, onClose }: Props) {
  const [items, setItems] = useState<MeasurementItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setItems([]);
    setError(null);
    setLoading(baseId !== null);
    if (baseId !== null) {
      api.measurementItems(siteId, { measurementBaseId: baseId })
        .then(result => { if (!cancelled) setItems(result); })
        .catch(() => { if (!cancelled) setError("Angebotspositionen konnten nicht geladen werden."); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }
    return () => { cancelled = true; };
  }, [siteId, baseId, retry]);

  return <aside className="measurement-offer-sidebar" aria-label="Angebotsübersicht"
        onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
        <MeasurementOfferPositions name={name || (baseId === null ? "Kein Angebot zugeordnet" : "Zugeordnetes Angebot")}
          items={items} loading={loading} error={error} onRetry={() => setRetry(value => value + 1)} onClose={onClose} />
      </aside>;
}
