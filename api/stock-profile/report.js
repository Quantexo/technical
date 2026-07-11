export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol } = req.query;

  if (!symbol) {
    return res.status(400).json({ error: 'Symbol parameter is required' });
  }

  const symbolUpper = symbol.toUpperCase();
  const headers = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' };

  try {
    // 1. Fetch stock list to resolve symbol to ID
    const listUrl = 'https://nepselytics-6d61dea19f30.herokuapp.com/api/nepselytics/stock-list';
    const listResp = await fetch(listUrl, { headers });
    if (!listResp.ok) {
      return res.status(listResp.status).json({ error: 'Failed to fetch stock list from NEPSElytics' });
    }
    const stocks = await listResp.json();

    let stockId = null;
    for (const stock of stocks) {
      if (stock.symbol && stock.symbol.toUpperCase() === symbolUpper) {
        stockId = stock.id;
        break;
      }
    }

    if (!stockId) {
      return res.status(404).json({ error: `Stock ID not found for symbol: ${symbolUpper}` });
    }

    // 2. Fetch stock report by ID
    const reportUrl = `https://nepselytics-6d61dea19f30.herokuapp.com/api/nepselytics/stock-report/${stockId}`;
    const reportResp = await fetch(reportUrl, { headers });
    if (!reportResp.ok) {
      return res.status(reportResp.status).json({ error: `Failed to fetch stock report for ID ${stockId}` });
    }

    const reportData = await reportResp.json();
    return res.status(200).json(reportData);
  } catch (err) {
    console.error('Stock report error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
}
