import React, { useEffect, useState } from 'react';
import Button from './ui/Button';
import { PAPER_REQUEST_EVENT, getLatestPaperRequest, canPrepareAnotherPaperOrder, prepareAnotherPaperOrder, refreshPaperOrderRequest, retryPaperOrder, paperOrderStatusMessage } from '../utils/paperOrderRequest';
import { getApiError } from '../utils/api';

export default function PaperOrderIntentPanel({ surface, symbol }) {
  const [record, setRecord] = useState(() => getLatestPaperRequest(surface, symbol));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const update = () => setRecord(getLatestPaperRequest(surface, symbol));
    update();
    window.addEventListener(PAPER_REQUEST_EVENT, update);
    const saved = getLatestPaperRequest(surface, symbol);
    if (saved && saved.status !== 'prepared') refreshPaperOrderRequest(saved.key).catch(err => setError(getApiError(err)));
    return () => window.removeEventListener(PAPER_REQUEST_EVENT, update);
  }, [surface, symbol]);
  if (!record) return null;
  const resolved = canPrepareAnotherPaperOrder(record);
  const act = async fn => {
    setBusy(true); setError('');
    try { await fn(); }
    catch (err) { setError(getApiError(err)); }
    finally { setBusy(false); }
  };
  return (
    <section data-testid="paper-intent-panel" className="rt-panel p-3 mt-3 space-y-2" aria-label="Previous order request">
      <p className="text-sm font-semibold">{record.payload.side?.toUpperCase()} {record.payload.qty} {record.payload.symbol}</p>
      <p className="text-xs">{record.executionSource === 'alpaca-paper' ? 'Alpaca paper' : record.executionSource === 'local-simulation' ? 'Local simulator' : 'Execution source awaiting confirmation'}</p>
      <p role="status" data-testid="paper-intent-status" className="text-xs">{paperOrderStatusMessage(record.status)}</p>
      {record.status !== 'prepared' && <p className="text-xs">Filled {record.filledQty ?? 0} of {record.payload.qty} requested shares · {String(record.status).replaceAll('_', ' ')}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" disabled={busy || record.status === 'prepared'} onClick={() => act(() => refreshPaperOrderRequest(record.key))}>Refresh order status</Button>
        <Button variant="secondary" size="sm" disabled={busy || resolved} onClick={() => act(() => retryPaperOrder(record.key))}>{record.status === 'prepared' ? 'Submit prepared order' : 'Retry same order'}</Button>
        <Button variant="secondary" size="sm" disabled={busy || !resolved} onClick={() => act(() => prepareAnotherPaperOrder(record.key))}>Prepare another identical order</Button>
      </div>
      <p className="text-xs text-slate-500">Retries keep this request. Preparing another order does not submit it; review its quantity and submit explicitly.</p>
      {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
    </section>
  );
}
