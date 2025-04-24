import { useParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import axios from 'axios';

export default function Stock() {
  const { symbol } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setError(''); setData(null);
    axios.get(`/api/recommend/${symbol}`)
      .then(res => setData(res.data))
      .catch(err => setError(err.response?.data?.error || err.message));
  }, [symbol]);

  if (error) return <p style={{ color: 'red', padding: 20 }}>{error}</p>;
  if (!data)  return <p style={{ padding: 20 }}>Loading {symbol}…</p>;

  const { recommendation, instructions } = data;

  // Dummy handlers – replace with real trade API calls later
  const handleAction = (action) => () => {
    alert(`${action} ${symbol} – follow steps:\n${instructions.join('\n')}`);
  };

  return (
    <div style={{ padding: 20 }}>
      <h2>{symbol} Recommendation: {recommendation}</h2>
      <ol>
        {instructions.map(step => <li key={step}>{step}</li>)}
      </ol>
      <div style={{ marginTop: 20, display: 'flex', gap: 10 }}>
        <button onClick={handleAction('BUY')} style={{ padding: '8px 16px' }}>Buy</button>
        <button onClick={handleAction('SELL')} style={{ padding: '8px 16px' }}>Sell</button>
        <button onClick={handleAction('SHORT')} style={{ padding: '8px 16px' }}>Short</button>
      </div>
    </div>
  );
}
