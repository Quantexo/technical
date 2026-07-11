export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol } = req.query;

  if (!symbol) {
    return res.status(400).json({ error: 'Missing symbol parameter' });
  }

  try {
    const symbolUpper = symbol.toUpperCase();
    const url = `https://sharehubnepal.com/data/api/v1/price-history/graph/${symbolUpper}?time=1Y`;
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });

    if (!response.ok) {
      return res.status(response.status).json({ error: `Failed to fetch historical data for ${symbolUpper}` });
    }

    const rawData = await response.json();
    const mappedCandles = [];

    for (const d of rawData) {
      const tVal = d.time || d.date;
      if (!tVal) continue;

      let dateStr;
      if (typeof tVal === 'number') {
        dateStr = new Date(tVal * 1000).toISOString().split('T')[0];
      } else {
        dateStr = String(tVal).split('T')[0];
      }

      mappedCandles.push({
        Date: dateStr,
        Open: parseFloat(d.openPrice || d.open || d.contractRate || d.price || d.y || d.value || 0),
        High: parseFloat(d.high || d.highPrice || d.contractRate || d.price || d.y || d.value || 0),
        Low: parseFloat(d.low || d.lowPrice || d.contractRate || d.price || d.y || d.value || 0),
        Close: parseFloat(d.contractRate || d.price || d.close || d.closePrice || d.y || d.value || 0),
        Volume: parseFloat(d.volume || d.vol || d.turnover || 0)
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        data: mappedCandles
      }
    });
  } catch (err) {
    console.error('Symbol-data error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
}
