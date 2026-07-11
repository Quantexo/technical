export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol } = req.query;

  if (!symbol) {
    return res.status(400).json({ error: 'Symbol parameter is required' });
  }

  try {
    const url = `https://sharehubnepal.com/live/api/v2/nepselive/market-depth/${symbol.toUpperCase()}`;
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
    if (!response.ok) {
      return res.status(response.status).json({ error: `Failed to fetch market depth for ${symbol}` });
    }
    const data = await response.json();
    return res.status(200).json(data);
  } catch (err) {
    console.error('Market depth error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
}
