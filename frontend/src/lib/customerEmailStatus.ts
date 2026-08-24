export type CustomerEmailStatusItem = {
  customer_email_sent_at: string | null;
  customer_email_signature_present: boolean | null;
  customer_signed_at: string | null;
  customer_signature_name?: string | null;
  is_locked_for_worker?: boolean;
};

export type CustomerEmailStatusPresentation = {
  accessibleLabel: string;
  className: "is-not-sent" | "is-signature-open" | "is-complete";
  isSent: boolean;
  label: string;
};

export function getCustomerEmailStatus(
  item: CustomerEmailStatusItem,
): CustomerEmailStatusPresentation {
  if (!item.customer_email_sent_at) {
    return {
      accessibleLabel: "Noch nicht an Kunden gesendet",
      className: "is-not-sent",
      isSent: false,
      label: "Nicht an Kunden gesendet",
    };
  }

  const signaturePresent = Boolean(
    item.customer_signed_at || item.customer_signature_name || item.is_locked_for_worker,
  ) || item.customer_email_signature_present === true;
  const sentAt = formatCustomerEmailSentDate(item.customer_email_sent_at);
  if (signaturePresent) {
    const label = `An Kunden gesendet - Unterschrift erhalten · ${sentAt}`;
    return {
      accessibleLabel: label,
      className: "is-complete",
      isSent: true,
      label,
    };
  }

  const label = `An Kunden gesendet · Unterschrift fehlt · ${sentAt}`;
  return {
    accessibleLabel: label,
    className: "is-signature-open",
    isSent: true,
    label,
  };
}

function formatCustomerEmailSentDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "-";
  }
  return new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  }).format(parsed);
}
