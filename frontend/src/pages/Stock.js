import { useParams } from 'react-router-dom';
import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { LineChart, Line, XAxis, YAxis, Tooltip, BarChart, Bar } from 'recharts';

export default function Stock() {
  const { symbol } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  // Intraday states
  const [intraday, setIntraday] = useState([]);
  const [intradayError, setIntradayError] = useState('');
  const [intradayLoading, setIntradayLoading] = useState(true);

  useEffect(() => {
    setError(''); setData(null);
    axios.get(`/api/recommend/${symbol}`)
      .then(res => setData(res.data))
      .catch(err => setError(err.response?.data?.error || err.message));
  }, [symbol]);

  useEffect(() => {
    setIntradayLoading(true);
    setIntradayError('');
    axios.get(`/api/intraday/${symbol}`)
      .then(res => setIntraday(res.data))
      .catch(err => {
        console.error(err);
        setIntradayError('Failed to load intraday data.');
      })
      .finally(() => setIntradayLoading(false));
  }, [symbol]);

  if (error)   return <p style={{ color: 'red', padding: 20 }}>{error}</p>;
  if (!data)   return <p style={{ padding: 20 }}>Loading {symbol}…</p>;

  const { recommendation, instructions } = data;
  const handleAction = (action) => async () => {
    try {
      const side = action.toLowerCase();
      const qty = 1;
      const resp = await axios.post('/api/trade', { symbol, side, qty });
      alert(`Order submitted! ID: ${resp.data.id}`);
    } catch (err) {
      const msg = err.response?.data?.message || err.message;
      alert(`Trade failed: ${msg}`);
    }
  };

  return (
    <div style={{ padding: 20 }}>
      <h2>{symbol} Recommendation: {recommendation}</h2>
      <ol>
        {instructions.map(step => <li key={step}>{step}</li>)}
      </ol>
      <div style={{ marginTop: 20, display: 'flex', gap: 10 }}>
        <button onClick={handleAction('BUY')}>Buy</button>
        <button onClick={handleAction('SELL')}>Sell</button>
        <button onClick={handleAction('SHORT')}>Short</button>
      </div>

      {/* Intraday Charts */}
      {intradayLoading && <p>Loading intraday...</p>}
      {intradayError && <p style={{ color: 'red' }}>{intradayError}</p>}
      {!intradayLoading && !intradayError && intraday.length > 0 && (
        <>
          <h3>Intraday Price (5-min)</h3>
          <LineChart width={600} height={200} data={intraday}>
            <XAxis dataKey="time" tickFormatter={t => t.slice(11,16)} />
            <YAxis domain={['auto','auto']} />
            <Tooltip />
            <Line type="monotone" dataKey="close" dot={false} />
          </LineChart>

          <h3>Intraday Volume</h3>
          <BarChart width={600} height={100} data={intraday}>
            <XAxis dataKey="time" tickFormatter={t => t.slice(11,16)} />
            <YAxis hide />
            <Tooltip />
            <Bar dataKey="volume" />
          </BarChart>
        </>
      )}
    </div>
  );
}
