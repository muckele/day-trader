import { useState } from "react";
import { useNavigate } from "react-router-dom";

export default function Home() {
  const [symbol, setSymbol] = useState('');
  const navigate = useNavigate();

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!symbol) return;
    navigate(`/stock/${symbol.toUpperCase()}`);
  };

  return (
    <div style={{ padding: 20 }}>
      <h2>Search a Stock</h2>
      <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 10 }}>
        <input
          value={symbol}
          onChange={e => setSymbol(e.target.value)}
          placeholder="e.g. AAPL"
          style={{ flex: 1, padding: 8, fontSize: 16 }}
        />
        <button type="submit" style={{ padding: '8px 16px' }}>
          Go
        </button>
      </form>
    </div>
  );
}