import { useEffect, useState } from 'react';
import axios from 'axios';
import { getCache, setCache } from '../utils/cache';
import { getApiError } from '../utils/api';
import { emitToast } from '../utils/toast';

const CACHE_KEY = 'market-status';

export function useMarketStatus() {
  const [status, setStatus] = useState('LOADING');
  const [source, setSource] = useState(null);
  const [nextOpen, setNextOpen] = useState(null);
  const [nextClose, setNextClose] = useState(null);
  const [countdown, setCountdown] = useState('');

  useEffect(() => {
    let active = true;
    const apply = data => {
      if (!active) return;
      setStatus(['OPEN', 'CLOSED'].includes(data?.status) ? data.status : 'UNAVAILABLE');
      setSource(data?.source || null);
      setNextOpen(data?.nextOpen || null);
      setNextClose(data?.nextClose || null);
    };
    const fetchStatus = async () => {
      const cached = getCache(CACHE_KEY);
      if (cached) { apply(cached); return; }
      try {
        const res = await axios.get('/api/market/status');
        apply(res.data);
        if (active) setCache(CACHE_KEY, res.data, 30 * 1000);
      } catch (err) {
        apply({ status: 'UNAVAILABLE', source: err.response?.data?.source });
        if (active) emitToast({ type: 'error', message: getApiError(err) });
      }
    };
    fetchStatus();
    const interval = setInterval(fetchStatus, 30000);
    return () => { active = false; clearInterval(interval); };
  }, []);

  useEffect(() => {
    if (status !== 'CLOSED' || !nextOpen) {
      setCountdown('');
      return;
    }

    const update = () => {
      const diff = new Date(nextOpen).getTime() - Date.now();
      if (diff <= 0) {
        setCountdown('Opening soon');
        return;
      }
      const hours = Math.floor(diff / (1000 * 60 * 60));
      const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      setCountdown(`${hours}h ${minutes}m`);
    };

    update();
    const interval = setInterval(update, 60 * 1000);
    return () => clearInterval(interval);
  }, [status, nextOpen]);

  return { status, source, nextOpen, nextClose, countdown };
}
