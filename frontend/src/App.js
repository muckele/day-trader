import React, { useState } from 'react';
import axios from 'axios';

function App() {
  const [symbol, setSymbol] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const fetchReco = async () => {
    setError(''); setData(null);
    try {
      const res = await axios.get(`/api/recommend/${symbol}`);
      setData(res.data);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  return (
    <div style={{ maxWidth: 600, margin: 'auto', padding: 20 }}>
      <h1>Day Trader</h1>
      <input
        value={symbol}
        onChange={e => setSymbol(e.target.value.toUpperCase())}
        placeholder="Enter ticker (e.g. AAPL)"
        style={{ padding: 8, fontSize: 16 }}
      />
      <button onClick={fetchReco} style={{ marginLeft: 8, padding: '8px 16px' }}>
        Get Recommendation
      </button>

      {error && <p style={{ color: 'red' }}>{error}</p>}
      {data && (
        <div style={{ marginTop: 20 }}>
          <h2>{data.symbol}: {data.recommendation}</h2>
          <p>20-day SMA: {data.sma20} | 50-day SMA: {data.sma50}</p>
          <ol>
            {data.instructions.map(step => <li key={step}>{step}</li>)}
          </ol>
        </div>
      )}
    </div>
  );
}

export default App;
