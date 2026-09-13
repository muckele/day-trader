const { mapIntent } = require('./alpacaPortfolioService');
async function submitAlpacaEntry(payload, lifecycle) {
  const service = lifecycle || require('./orderLifecycleService').getOrderLifecycle();
  const { userId, idempotencyKey, origin = 'manual', ...orderInput } = payload;
  const result = await service.submit({ userId, idempotencyKey, origin: ['manual', 'research', 'trade_plan'].includes(origin) ? origin : 'manual', orderInput });
  const record = result.brokerOrder;
  const brokerOrder = record?.externalOrderId ? { id: record.externalOrderId, status: record.status, client_order_id: record.clientOrderId } : null;
  return { ...result, brokerOrder, executionSource: 'alpaca-paper', broker: 'alpaca', order: { ...mapIntent(result.intent), externalOrderId: brokerOrder?.id || null }, trade: null, attachedOrders: [] };
}
module.exports = { submitAlpacaEntry };
