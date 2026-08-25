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

export async function performExtraWorkTicketInvoicedUpdate({
  ticket,
  request,
  onOptimistic,
  onCanonical,
  onRollback,
}: {
  ticket: MobileExtraWorkTicket;
  request: (isInvoiced: boolean) => Promise<MobileExtraWorkTicket>;
  onOptimistic: (state: ExtraWorkTicketInvoicedState) => void;
  onCanonical: (state: ExtraWorkTicketInvoicedState) => void;
  onRollback: (state: ExtraWorkTicketInvoicedState) => void;
}): Promise<void> {
  const previousState = {
    is_invoiced: ticket.is_invoiced,
    status: ticket.status,
  };
  const nextValue = !previousState.is_invoiced;
  onOptimistic({
    is_invoiced: nextValue,
    status: nextValue ? "billed" : previousState.status,
  });
  try {
    const updated = await request(nextValue);
    onCanonical({
      is_invoiced: updated.is_invoiced,
      status: updated.status,
    });
  } catch (error) {
    onRollback(previousState);
    throw error;
  }
}
