export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const type = req.query.type;
  const forCategory = req.query.for;
  const size = Math.min(100, Math.max(1, parseInt(req.query.size, 10) || 30));

  if (type === undefined || forCategory === undefined) {
    return res.status(400).json({ error: 'Missing type or for parameter' });
  }

  try {
    const url = `https://sharehubnepal.com/data/api/v1/public-offering?size=${size}&type=${type}&for=${forCategory}`;
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Failed to fetch offerings' });
    }
    const data = await response.json();
    return res.status(200).json(data);
  } catch (err) {
    console.error('Offerings error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
}
