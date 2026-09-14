import type { MobileMeasurementBatch } from "../types/site";

// Only current values appear in the calendar. Signed originals and redlines
// belong exclusively to the PDF; the editor just needs their availability.
export function canEditMeasurementContent(batch: Pick<MobileMeasurementBatch, "status" | "deleted_at" | "customer_signed_at" | "has_signed_snapshot">, allowed: boolean) {
  return allowed && !batch.deleted_at
    && !["billed", "approved", "closed", "completed", "finalized", "abgeschlossen", "archived"].includes(batch.status.toLowerCase())
    && (!batch.customer_signed_at || batch.has_signed_snapshot === true);
}
