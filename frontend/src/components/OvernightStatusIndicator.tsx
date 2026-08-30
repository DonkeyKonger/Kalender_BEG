import { BedDouble, X } from "lucide-react";

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

  if (status === null || status === undefined) {
    return (
      <span
        aria-label={label}
        className="time-review-overnight-indicator is-unset"
        role="img"
        title={label}
      >
        <span className="time-review-overnight-marker" aria-hidden="true">–</span>
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
        {presentation.tone === "none" && (
          <span className="time-review-overnight-no-stay-mark">
            <X size={10} strokeWidth={3} />
          </span>
        )}
        {presentation.badge ? (
          <span className="time-review-overnight-payer-strip">{presentation.badge}</span>
        ) : null}
      </span>
    </span>
  );
}
