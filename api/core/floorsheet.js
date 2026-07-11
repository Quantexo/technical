export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const page = Math.max(0, parseInt(req.query.page, 10) || 0);
  const size = Math.min(500, Math.max(1, parseInt(req.query.size, 10) || 500));
  const order = req.query.order === 'asc' ? 'asc' : 'desc';

  const floorsheetUrl = 'https://nepselytics-6d61dea19f30.herokuapp.com/api/nepselytics/floorsheet';
  const headers = { 'User-Agent': 'Mozilla/5.0' };

  try {
    if (size > 100) {
      const allRecords = [];
      const pagesNeeded = Math.ceil(size / 100);
      for (let i = 0; i < pagesNeeded; i++) {
        const url = `${floorsheetUrl}?page=${page + i}&Size=100&order=${order}`;
        const response = await fetch(url, { headers });
        if (!response.ok) break;
        const result = await response.json();
        const records = result.data?.content || [];
        allRecords.push(...records);
        if (records.length < 100) break;
      }
      return res.status(200).json({ success: true, data: allRecords.slice(0, size) });
    } else {
      const url = `${floorsheetUrl}?page=${page}&Size=${size}&order=${order}`;
      const response = await fetch(url, { headers });
      if (!response.ok) {
        return res.status(response.status).json({ error: 'Failed to fetch floorsheet' });
      }
      const data = await response.json();
      return res.status(200).json(data);
    }
  } catch (err) {
    console.error('Floorsheet error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
}
