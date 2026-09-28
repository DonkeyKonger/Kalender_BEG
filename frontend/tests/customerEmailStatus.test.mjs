import assert from "node:assert/strict";
import test from "node:test";

import { getCustomerEmailStatus } from "../src/lib/customerEmailStatus.ts";

const baseStatus = {
  customer_email_sent_at: null,
  customer_email_signature_present: null,
  customer_signed_at: null,
};

test("customer delivery status marks an unsent record with an explicit accessible label", () => {
  assert.deepEqual(getCustomerEmailStatus(baseStatus), {
    accessibleLabel: "Noch nicht an Kunden gesendet",
    className: "is-not-sent",
    isSent: false,
    label: "Nicht an Kunden gesendet",
  });
});

test("customer delivery status keeps sent state even when a legacy timestamp is invalid", () => {
  const presentation = getCustomerEmailStatus({
    ...baseStatus,
    customer_email_sent_at: "legacy-sent-value",
  });

  assert.equal(presentation.isSent, true);
  assert.equal(presentation.className, "is-signature-open");
  assert.equal(presentation.accessibleLabel, "An Kunden gesendet · Unterschrift fehlt · -\nEmpfänger nicht hinterlegt");
});

test("customer delivery tooltip preserves the formatted send date", () => {
  const presentation = getCustomerEmailStatus({
    ...baseStatus,
    customer_email_sent_at: "2026-08-24T10:15:00Z",
  });

  assert.equal(presentation.isSent, true);
  assert.match(presentation.accessibleLabel, /^An Kunden gesendet · Unterschrift fehlt · 24\.08\.26\nEmpfänger nicht hinterlegt$/);
});

test("customer delivery tooltip reports a received signature", () => {
  const presentation = getCustomerEmailStatus({
    ...baseStatus,
    customer_email_sent_at: "2026-08-24T10:15:00Z",
    customer_email_signature_present: true,
    customer_email_recipients: ["kunde@example.de", "bauleitung@example.de"],
  });

  assert.equal(presentation.isSent, true);
  assert.equal(presentation.className, "is-complete");
  assert.equal(presentation.accessibleLabel, "An Kunden gesendet - Unterschrift erhalten · 24.08.26\nEmpfänger: kunde@example.de, bauleitung@example.de");
});

test("sent documents without a signature also expose recorded recipients", () => {
  const result = getCustomerEmailStatus({ ...baseStatus, customer_email_sent_at: "2026-09-28T08:00:00Z", customer_email_recipients: [" kunde@example.de ", ""] });
  assert.equal(result.className, "is-signature-open");
  assert.match(result.accessibleLabel, /\nEmpfänger: kunde@example.de$/);
});

test("unsent documents never claim a recipient even if stale recipient metadata exists", () => {
  assert.equal(getCustomerEmailStatus({ ...baseStatus, customer_email_recipients: ["kunde@example.de"] }).accessibleLabel, "Noch nicht an Kunden gesendet");
});
