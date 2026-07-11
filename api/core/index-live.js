export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const timestamp = Date.now();
    const url = `https://nepalipaisa.com/api/GetIndexLive?_=${timestamp}`;
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://nepalipaisa.com' } });
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Failed to fetch index live data' });
    }
    const data = await response.json();
    return res.status(200).json(data);
  } catch (err) {
    console.error('Index live error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
}
