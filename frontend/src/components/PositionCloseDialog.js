import React, { useEffect, useState } from 'react';
import Button from './ui/Button';
import Card from './ui/Card';
import { readPositionClose, requestPositionClose, refreshPositionClose, preparePositionClose, terminalClose } from '../utils/positionCloseRequest';
import { getApiError } from '../utils/api';
export default function PositionCloseDialog({ symbol, onDismiss }) {
  const [record, setRecord] = useState(() => readPositionClose(symbol));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    refreshPositionClose(symbol).then(value => { if (active) setRecord(value); }).catch(err => { if (active) setError(getApiError(err)); });
    return () => { active = false; };
  }, [symbol]);
  const act = async fn => {
    setBusy(true); setError('');
    try { setRecord(await fn(symbol)); } catch (err) { setError(getApiError(err)); setRecord(readPositionClose(symbol)); }
    finally { setBusy(false); }
  };
  return <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50" role="dialog" aria-modal="true" aria-label={`Close ${symbol} position`}>
    <Card className="p-6 max-w-lg space-y-4">
      <h2 className="text-lg font-bold">Close {symbol} · Alpaca paper</h2>
      <p className="text-sm">This coordinated close first resolves or cancels linked orders, then sells the actual remaining whole-share position. Until cancellation is confirmed, existing orders may still fill.</p>
      <p role="status" data-testid="position-close-status">{record ? `Close status: ${record.state.replaceAll('_', ' ')}` : 'Review before submitting the close request.'}</p>
      {record?.state === 'reconciliation_required' && <p className="text-sm">Operator review required. Refresh this request before taking further action.</p>}
      {record?.state === 'filled' && <p className="text-sm">The close order filled. Refresh the portfolio to see the current broker position.</p>}
      {record?.state === 'flat' && <p className="text-sm">The broker reports no remaining position to close.</p>}
      {record?.error && <p className="text-sm text-amber-500">{record.error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || terminalClose(record)} onClick={() => act(requestPositionClose)}>{!record || record.state === 'prepared' ? 'Confirm coordinated close' : 'Retry coordinated close'}</Button>
        <Button variant="secondary" disabled={busy || !record || record.state === 'prepared'} onClick={() => act(refreshPositionClose)}>Refresh close status</Button>
        {terminalClose(record) && <Button variant="secondary" disabled={busy} onClick={() => act(preparePositionClose)}>Prepare another close</Button>}
        <Button variant="ghost" onClick={onDismiss}>Done</Button>
      </div>
      {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
    </Card>
  </div>;
}
