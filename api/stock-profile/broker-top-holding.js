export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, days = 1 } = req.query;

  if (!symbol) {
    return res.status(400).json({ error: 'Symbol parameter is required' });
  }

  try {
    const url = `https://nepselytics-6d61dea19f30.herokuapp.com/api/nepselytics/broker-top-holding?symbol=${symbol.toUpperCase()}&days=${days}`;
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
    if (!response.ok) {
      return res.status(response.status).json({ error: `Failed to fetch broker top holdings for ${symbol}` });
    }
    const data = await response.json();
    return res.status(200).json(data);
  } catch (err) {
    console.error('Broker top holding error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
}
