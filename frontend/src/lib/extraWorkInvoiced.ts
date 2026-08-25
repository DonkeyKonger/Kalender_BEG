import type { MobileExtraWorkTicket } from "../types/site";

export function setExtraWorkTicketInvoicedValue(
  tickets: MobileExtraWorkTicket[],
  ticketId: number,
  isInvoiced: boolean,
): MobileExtraWorkTicket[] {
  return tickets.map((ticket) => (
    ticket.id === ticketId
      ? { ...ticket, is_invoiced: isInvoiced }
      : ticket
  ));
}
