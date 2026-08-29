import { BedDouble } from "lucide-react";

import { getOvernightStatusPresentation } from "../lib/overnightStatus";
import type { OvernightStatus } from "../types/timeEntry";


export function OvernightStatusIndicator({
  status,
  hasConflict = false,
}: {
  status: OvernightStatus | null | undefined;
  hasConflict?: boolean;
}) {
  const presentation = getOvernightStatusPresentation(status);
  const label = hasConflict
    ? "Widersprüchliche Übernachtungszuordnungen – bitte prüfen"
    : presentation.label;

  if (hasConflict) {
    return (
      <span
        aria-label={label}
        className="time-review-overnight-indicator is-conflict"
        role="img"
        title={label}
      >
        <span className="time-review-overnight-marker" aria-hidden="true">!</span>
      </span>
    );
  }

  if (presentation.marker) {
    return (
      <span
        aria-label={label}
        className={`time-review-overnight-indicator is-${presentation.tone}`}
        role="img"
        title={label}
      >
        <span className="time-review-overnight-marker" aria-hidden="true">{presentation.marker}</span>
      </span>
    );
  }

  return (
    <span
      aria-label={label}
      className={`time-review-overnight-indicator is-${presentation.tone}`}
      role="img"
      title={label}
    >
      <span className="time-review-overnight-bed" aria-hidden="true">
        <BedDouble size={17} strokeWidth={2.25} />
        <span className="time-review-overnight-payer-strip">{presentation.badge}</span>
      </span>
    </span>
  );
}
