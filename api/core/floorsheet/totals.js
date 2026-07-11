export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const url = 'https://nepselytics-6d61dea19f30.herokuapp.com/api/nepselytics/floorsheet?page=0&Size=1&order=desc';
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Failed to fetch floorsheet totals' });
    }
    const result = await response.json();
    const data = result.data || {};
    return res.status(200).json({
      success: true,
      data: {
        totalAmount: data.totalAmount || 0,
        totalQty: data.totalQty || 0,
        totalTrades: data.totalTrades || 0
      }
    });
  } catch (err) {
    console.error('Floorsheet totals error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
}
