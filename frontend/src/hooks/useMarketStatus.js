import { useEffect, useState } from 'react';
import axios from 'axios';
import { getCache, setCache } from '../utils/cache';
import { getApiError } from '../utils/api';
import { emitToast } from '../utils/toast';

const CACHE_KEY = 'market-status';

export function useMarketStatus() {
  const [status, setStatus] = useState('CLOSED');
  const [nextOpen, setNextOpen] = useState(null);
  const [nextClose, setNextClose] = useState(null);
  const [countdown, setCountdown] = useState('');

  useEffect(() => {
    const fetchStatus = async () => {
      const cached = getCache(CACHE_KEY);
      if (cached) {
        setStatus(cached.status);
        setNextOpen(cached.nextOpen);
        setNextClose(cached.nextClose);
        return;
      }
      try {
        const res = await axios.get('/api/market/status');
        setStatus(res.data.status);
        setNextOpen(res.data.nextOpen);
        setNextClose(res.data.nextClose);
        setCache(CACHE_KEY, res.data, 30 * 1000);
      } catch (err) {
        emitToast({ type: 'error', message: getApiError(err) });
      }
    };

    fetchStatus();
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

  return { status, nextOpen, nextClose, countdown };
}
