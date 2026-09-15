import { ArrowRight, Check, RotateCcw } from "lucide-react";
import type { MobileMeasurementBatch } from "../types/site";
import { getMeasurementReviewSteps } from "../lib/measurementReviewSteps";
import "./MeasurementReviewStatusBar.css";

type Props = {
  batch: MobileMeasurementBatch;
  busy: boolean;
  isBilled: boolean;
  canReview: boolean;
  onRollbackStatus: (batch: MobileMeasurementBatch) => void;
  onMarkReviewed: (batch: MobileMeasurementBatch) => void;
  onMarkBilled: (batch: MobileMeasurementBatch) => void;
};

export function MeasurementReviewStatusBar(props: Props) {
  const { batch, busy } = props;
  const rollbackTarget = batch.previous_status ?? (batch.status !== "submitted" ? "submitted" : null);
  const rollbackIsFallback = batch.status_rollback_is_fallback || !batch.previous_status;
  const statusLabels: Record<string, string> = { draft: "Entwurf", rejected: "Zurückgewiesen", in_review: "In Prüfung", submitted: "Eingereicht", reviewed: "Geprüft", customer_signed: "Unterschrieben", billed: "Abgeschlossen" };
  const statusAliases: Record<string, string> = { checked: "reviewed", signed: "customer_signed", approved: "billed", closed: "billed", completed: "billed", finalized: "billed" };
  const targetStep = rollbackTarget ? statusAliases[rollbackTarget] ?? rollbackTarget : null;
  const rollbackLabel = targetStep ? statusLabels[targetStep] ?? targetStep : "";
  const rollbackDescription = rollbackIsFallback
    ? "Keine verlässliche Statushistorie vorhanden: auf Eingereicht zurücksetzen."
    : `Letzten Statuswechsel rückgängig machen: ${rollbackLabel}`;
  const steps = getMeasurementReviewSteps(batch).map((step, index) => ({ ...step, number: index + 1 }));
  // Keep real predecessors outside the usual four stages reachable, too (e.g. draft).
  if (targetStep && !steps.some(step => step.status === targetStep)) {
    steps.unshift({ status: targetStep, label: rollbackLabel, state: "reached", description: rollbackDescription, number: 0 });
  }
  return (
    <div className="measurement-review-statusbar">
        <div className="measurement-review-process-scroll" tabIndex={0} aria-label="Bearbeitungsablauf des Aufmaßes">
          <ol className="measurement-review-process" aria-label="Prüfstatus">
            {steps.map((step, index) => {
              const canRollback = step.status === targetStep;
              const content = <>
                <span className="measurement-review-process-icon" aria-hidden="true">
                  {step.number === 0 ? <RotateCcw /> : step.state === "reached" || (step.state === "current" && step.number === 4) ? <Check /> : step.number}
                </span>
                <span>{step.label}</span>
                <span className="measurement-review-process-sr">: {step.description}</span>
              </>;
              return (
              <li key={step.label} className={`is-${step.state}`} aria-current={step.state === "current" ? "step" : undefined}>
                {index > 0 ? <ArrowRight className="measurement-review-process-arrow" aria-hidden="true" /> : null}
                {canRollback ? (
                  <button type="button" className="measurement-review-process-step is-rollback" disabled={busy}
                    aria-label={`Auf ${rollbackLabel} zurücksetzen`} title={rollbackDescription}
                    onClick={() => props.onRollbackStatus(batch)}>{content}</button>
                ) : <span className="measurement-review-process-step" title={step.description}>{content}</span>}
              </li>
              );
            })}
          </ol>
        </div>
      <div className="measurement-review-process-actions">
        {!props.isBilled ? (
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
        ) : null}
      </div>
    </div>
  );
}
