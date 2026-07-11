export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const url = 'https://tms59.nepsetms.com.np/tmsapi/rtApi/admin/vCache/marketTurnover';
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Failed to fetch market turnover' });
    }
    const data = await response.json();
    return res.status(200).json(data);
  } catch (err) {
    console.error('Market turnover error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
}
