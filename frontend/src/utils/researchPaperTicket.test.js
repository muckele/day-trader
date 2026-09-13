import { researchPaperTicket } from './researchPaperTicket';
test('research target stays informational while entry uses a regular-hours limit and protective stop', () => {
  const payload = researchPaperTicket({ symbol: 'AAPL', side: 'buy', qty: 2, orderType: 'market', entryPrice: 100, maxPricePerShare: 101, takeProfitPrice: 120, stopLossPrice: 95, allowExtendedHours: false });
  expect(payload.orderType).toBe('limit');
  expect(payload.limitPrice).toBe(101);
  expect(payload.stopLossPrice).toBe(95);
  expect(payload.takeProfitPrice).toBeNull();
  expect(payload.allowExtendedHours).toBe(false);
});
test('research execution requires a finite explicit ceiling and whole shares', () => {
  expect(() => researchPaperTicket({ side: 'buy', qty: 1 })).toThrow(/limit/i);
  expect(() => researchPaperTicket({ side: 'buy', qty: 0.5, limitPrice: 100 })).toThrow(/whole/i);
});
