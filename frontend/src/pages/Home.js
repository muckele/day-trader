import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';

export default function Home() {
  const [trades, setTrades]   = useState([]); // { symbol, recommendation }
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    setLoading(true);
    axios.get('/api/recommendations')
      .then(res => setTrades(res.data))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p>Loading recommendations…</p>;
  if (error)   return <p className="text-red-500">{error}</p>;
  
  return (
    <div>
      <h1 className="text-3xl font-bold mb-4">Your Daily Recommendations</h1>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {trades.map(({ symbol, recommendation }) => (
          <div
            key={symbol}
            onClick={() => navigate(`/stock/${symbol}`)}
            className="cursor-pointer border rounded-lg p-4 hover:shadow-lg transition"
          >
            <h2 className="text-xl font-semibold">{symbol}</h2>
            <p className={`mt-2 font-bold ${
              recommendation === 'LONG' ? 'text-green-600' : 'text-red-600'
            }`}>
              {recommendation === 'LONG' ? 'Buy' : 'Short'}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
