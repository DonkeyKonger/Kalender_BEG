import type { MobileMeasurementBatch } from "../types/site";

// Completion and customer signatures are independent in this application.
// In particular, closing a batch does not prove it was reviewed or signed.
export function getMeasurementReviewSteps(batch: Pick<MobileMeasurementBatch, "status" | "submitted_at" | "customer_signed_at" | "customer_signature_name" | "status_path">) {
  const status = batch.status.toLowerCase();
  const completed = ["billed", "approved", "closed", "completed", "finalized"].includes(status);
  const reviewed = ["reviewed", "checked"].includes(status);
  const submitted = ["submitted", "rejected", "in_review"].includes(status);
  const signed = Boolean(batch.customer_signed_at || batch.customer_signature_name);
  const current = completed ? 3 : reviewed ? 1 : submitted ? 0 : status === "customer_signed" && signed ? 2 : -1;
  const evidence = [batch.status_path ? batch.status_path.includes("submitted") || submitted : Boolean(batch.submitted_at) || submitted,
    reviewed || Boolean(batch.status_path?.some(value => ["reviewed", "checked"].includes(value))), signed, completed];
  return ["Eingereicht", "Geprüft", "Unterschrieben", "Abgeschlossen"].map((label, index) => {
    const state = index === current ? "current" : evidence[index] ? "reached" : "pending";
    return {
      label, state,
      description: state === "current" ? "Aktueller Status" : state === "reached" ? "Nachgewiesen" : "Noch nicht nachgewiesen",
    };
  });
}
