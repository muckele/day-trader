// inside Stock.js
const handleAction = (action) => async () => {
  try {
    const side = action.toLowerCase();    // 'buy' | 'sell' | 'short'
    const qty = 1;                        // you can prompt the user for qty later
    const resp = await axios.post('/api/trade', { symbol, side, qty });
    // resp.data holds the JSON your backend returned
    alert(`Order submitted! ID: ${resp.data.id}`);
  } catch (err) {
    // ensure the fallback works as intended
    const msg = err.response?.data?.message || err.message;
    alert(`Trade failed: ${msg}`);
  }
};
git