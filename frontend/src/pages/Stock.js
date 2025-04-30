import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { useParams } from 'react-router-dom';
import { LineChart, Line, XAxis, YAxis, Tooltip } from 'recharts';

export default function Stock() {
  const { symbol } = useParams();
  const [info, setInfo]         = useState(null);
  const [intraday, setIntraday] = useState([]);
  const [error, setError]       = useState('');

  useEffect(() => {
    axios.get(`/api/market/quote/${symbol}`)
      .then(res => setInfo(res.data))
      .catch(err => setError(err.message));
    axios.get(`/api/intraday/${symbol}`)
      .then(res => setIntraday(res.data))
      .catch(err => console.error(err));
  }, [symbol]);

  if (error) return <p className="text-red-500">{error}</p>;
  if (!info) return <p>Loading {symbol}…</p>;

  return (
    <div>
      <h1 className="text-3xl font-bold">{info.companyName} ({symbol})</h1>
      <p className="text-2xl my-2">${info.latestPrice.toFixed(2)}</p>

      {intraday.length > 0 && (
        <>
          <h2 className="mt-6 mb-2 font-semibold">Intraday (5-min)</h2>
          <LineChart width={800} height={200} data={intraday}>
            <XAxis dataKey="time" tickFormatter={t => t.slice(11,16)} />
            <YAxis domain={['auto','auto']} />
            <Tooltip />
            <Line dataKey="close" dot={false} stroke="#1f8ef1" />
          </LineChart>
        </>
      )}
    </div>
  );
}
