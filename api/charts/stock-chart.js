export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, time = '1Y' } = req.query;

  if (!symbol) {
    return res.status(400).json({ error: 'Symbol parameter is required' });
  }

  try {
    let url;
    if (time === '1D') {
      url = `https://sharehubnepal.com/live/api/v1/daily-graph/company/${symbol.toUpperCase()}`;
    } else {
      url = `https://sharehubnepal.com/data/api/v1/price-history/graph/${symbol.toUpperCase()}?time=${time}`;
    }

    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!response.ok) {
      return res.status(response.status).json({ error: `Failed to fetch price history for ${symbol}` });
    }

    const data = await response.json();
    return res.status(200).json(data);
  } catch (err) {
    console.error('Stock chart error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
}
