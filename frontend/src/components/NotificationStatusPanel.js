import React, { useEffect, useState } from 'react';
import axios from 'axios';
import Card from './ui/Card';
import Button from './ui/Button';
import { getApiError } from '../utils/api';
const labels = { pending: 'Queued', sending: 'Sending · confirmation pending', retryable: 'Failed attempt · retry scheduled', provider_accepted: 'Provider accepted', failed: 'Failed · operator review required' };
export default function NotificationStatusPanel() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    axios.get('/api/robotrader/notifications').then(({ data }) => { if (active) setEvents(data.events || []); })
      .catch(err => { if (active) setError(getApiError(err)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [reload]);
  return <Card className="p-6 space-y-3" aria-label="Alpaca paper notification delivery">
    <h2 className="rt-section-title">Alpaca paper notification delivery</h2>
    <p className="text-sm text-slate-500">Provider acceptance does not prove inbox receipt.</p>
    {loading ? <p role="status">Loading notification states…</p> : error ? <p role="alert">{error}</p> : events.length ? events.map(event => <div key={event._id} className="rt-panel p-3">
      <p>{event.subject}</p><p className="text-sm">{labels[event.state] || 'Delivery state unavailable'}</p>
      <p className="text-xs text-slate-500">Attempts: {event.attempts}{event.providerAcceptedAt ? ` · Accepted ${new Date(event.providerAcceptedAt).toLocaleString()}` : ''}{event.state === 'retryable' && event.nextAttemptAt ? ` · Next attempt ${new Date(event.nextAttemptAt).toLocaleString()}` : ''}</p>
    </div>) : <p>No Alpaca paper notification events yet.</p>}
    <Button variant="secondary" disabled={loading} onClick={() => setReload(value => value + 1)}>Refresh notification states</Button>
  </Card>;
}
