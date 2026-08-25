import type { MobileExtraWorkTicket } from "../types/site";

export type ExtraWorkTicketInvoicedState = Pick<
  MobileExtraWorkTicket,
  "is_invoiced" | "status"
>;

export function applyExtraWorkTicketInvoicedState(
  ticket: MobileExtraWorkTicket,
  state: ExtraWorkTicketInvoicedState,
): MobileExtraWorkTicket {
  return { ...ticket, ...state };
}

export function setExtraWorkTicketInvoicedState(
  tickets: MobileExtraWorkTicket[],
  ticketId: number,
  state: ExtraWorkTicketInvoicedState,
): MobileExtraWorkTicket[] {
  return tickets.map((ticket) => (
    ticket.id === ticketId
      ? applyExtraWorkTicketInvoicedState(ticket, state)
      : ticket
  ));
}
