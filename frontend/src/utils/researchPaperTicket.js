// Research targets describe a thesis. This release submits simple capped entries
// with a separately managed stop; it does not promise a native take-profit child.
export function researchPaperTicket(ticket) {
  const qty = Number(ticket.qty);
  if (!Number.isSafeInteger(qty) || qty <= 0) throw new Error('Enter a positive whole-share quantity for paper execution.');
  const cap = Number(ticket.orderType === 'limit' ? ticket.limitPrice : ticket.maxPricePerShare);
  if (ticket.side === 'buy' && (!Number.isFinite(cap) || cap <= 0)) throw new Error('A positive limit price is required for paper entry.');
  if (ticket.allowExtendedHours) throw new Error('Paper execution is restricted to regular market hours.');
  return { ...ticket, qty, orderType: ticket.side === 'buy' ? 'limit' : ticket.orderType,
    limitPrice: ticket.side === 'buy' ? cap : ticket.limitPrice, takeProfitPrice: null, allowExtendedHours: false };
}
