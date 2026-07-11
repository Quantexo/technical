export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const size = Math.min(100, Math.max(1, parseInt(req.query.size, 10) || 12));

  try {
    const url = `https://sharehubnepal.com/data/api/v1/announcement?Page=${page}&Size=${size}`;
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Failed to fetch announcements' });
    }
    const data = await response.json();
    return res.status(200).json(data);
  } catch (err) {
    console.error('Announcements error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
}
