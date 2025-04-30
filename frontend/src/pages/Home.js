// src/pages/Home.js
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

  if (loading) return <p className="text-center mt-10 text-gray-500">Loading recommendations…</p>;
  if (error)   return <p className="text-center mt-10 text-red-500">{error}</p>;
  
  return (
    <div className="min-h-screen bg-gray-50 py-8">
      <div className="max-w-6xl mx-auto px-4">
        <h1 className="text-4xl font-extrabold text-gray-800 mb-6">
          Your Daily Recommendations
        </h1>
        <div className="grid gap-6 grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {trades.map(({ symbol, recommendation }) => {
            const isBuy = recommendation === 'LONG';
            return (
              <div
                key={symbol}
                onClick={() => navigate(`/stock/${symbol}`)}
                className="bg-white border border-gray-200 rounded-xl p-5 shadow-sm hover:shadow-md transition cursor-pointer"
              >
                <div className="flex items-center justify-between">
                  <h2 className="text-2xl font-semibold text-gray-900">{symbol}</h2>
                  <span
                    className={`px-2 py-1 rounded-full text-sm font-medium ${
                      isBuy ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                    }`}
                  >
                    {isBuy ? 'BUY' : 'SHORT'}
                  </span>
                </div>
                <p className="mt-2 text-gray-600">
                  {isBuy
                    ? 'Expect upward movement'
                    : 'Expect downward trend'}
                </p>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
