import { ArrowRight, Check, RotateCcw } from "lucide-react";
import type { MobileMeasurementBatch } from "../types/site";
import { getMeasurementReviewSteps } from "../lib/measurementReviewSteps";
import "./MeasurementReviewStatusBar.css";

type Props = {
  batch: MobileMeasurementBatch;
  busy: boolean;
  isBilled: boolean;
  canReview: boolean;
  onMarkOpen: (batch: MobileMeasurementBatch) => void;
  onMarkReviewed: (batch: MobileMeasurementBatch) => void;
  onMarkBilled: (batch: MobileMeasurementBatch) => void;
};

export function MeasurementReviewStatusBar(props: Props) {
  const { batch, busy } = props;
  return (
    <div className="measurement-review-statusbar">
      {batch.origin !== "OFFICE" ? (
        <div className="measurement-review-process-scroll" tabIndex={0} aria-label="Bearbeitungsablauf des Aufmaßes">
          <ol className="measurement-review-process" aria-label="Prüfstatus">
            {getMeasurementReviewSteps(batch).map((step, index) => (
              <li key={step.label} className={`is-${step.state}`} aria-current={step.state === "current" ? "step" : undefined}>
                {index > 0 ? <ArrowRight className="measurement-review-process-arrow" aria-hidden="true" /> : null}
                <span className="measurement-review-process-step" title={step.description}>
                  <span className="measurement-review-process-icon" aria-hidden="true">
                    {step.state === "reached" || (step.state === "current" && index === 3) ? <Check /> : index + 1}
                  </span>
                  <span>{step.label}</span>
                  <span className="measurement-review-process-sr">: {step.description}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      <div className="measurement-review-process-actions">
        {props.isBilled ? (
          <button type="button" className="secondary-action" disabled={busy} onClick={() => props.onMarkOpen(batch)}>
            <RotateCcw size={15} aria-hidden="true" />Status zurücksetzen
          </button>
        ) : (
          <>
            {props.canReview ? (
              <button type="button" className="primary-action" disabled={busy} onClick={() => props.onMarkReviewed(batch)}>
                Prüfung abschließen
              </button>
            ) : null}
            <button type="button" className="primary-action" disabled={busy} onClick={() => props.onMarkBilled(batch)}>
              Aufmaß abschließen
            </button>
          </>
        )}
      </div>
    </div>
  );
}
