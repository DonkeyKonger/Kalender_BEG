import { BedDouble } from "lucide-react";

import { getOvernightStatusPresentation } from "../lib/overnightStatus";
import type { OvernightStatus } from "../types/timeEntry";


export function OvernightStatusIndicator({ status }: { status: OvernightStatus | null | undefined }) {
  const presentation = getOvernightStatusPresentation(status);

  if (presentation.marker) {
    return (
      <span
        aria-label={presentation.label}
        className={`time-review-overnight-indicator is-${presentation.tone}`}
        role="img"
        title={presentation.label}
      >
        <span aria-hidden="true">{presentation.marker}</span>
      </span>
    );
  }

  return (
    <span
      aria-label={presentation.label}
      className={`time-review-overnight-indicator is-${presentation.tone}`}
      role="img"
      title={presentation.label}
    >
      <span className="time-review-overnight-bed" aria-hidden="true">
        <BedDouble size={17} strokeWidth={2.25} />
      </span>
      <span className="time-review-overnight-badge" aria-hidden="true">{presentation.badge}</span>
    </span>
  );
}
