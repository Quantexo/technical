// ─── CORS helper (Public Developer Access) ─────────────────────
function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Max-Age', '86400');
}

async function proxy(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!response.ok) throw Object.assign(new Error('Upstream error'), { status: response.status });
  return response.json();
}

// ─── Route dispatcher ─────────────────────────────────────────
// Routes:
//   GET /api/charts?route=stock-chart&symbol=XYZ&time=1Y
//   GET /api/charts?route=index-chart&symbol=NEPSE   (also sub-indices: DEVBANK, BANKING, etc.)
export default async function handler(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const route = req.query.route;
  const { symbol, time = '1Y' } = req.query;

  if (!symbol) {
    return res.status(400).json({ error: 'symbol parameter is required' });
  }

  try {
    switch (route) {
      case 'stock-chart': {
        let url;
        if (time === '1D') {
          url = `https://sharehubnepal.com/live/api/v1/daily-graph/company/${symbol.toUpperCase()}`;
        } else {
          url = `https://sharehubnepal.com/data/api/v1/price-history/graph/${symbol.toUpperCase()}?time=${time}`;
        }
        return res.status(200).json(await proxy(url));
      }

      case 'index-chart': {
        // Candle endpoint works for NEPSE and all sub-indices (DEVBANK, BANKING, SENSITIVE, etc.)
        const url = `https://sharehubnepal.com/live/api/v1/daily-graph/index/candle/${symbol.toUpperCase()}`;
        return res.status(200).json(await proxy(url));
      }

      default:
        return res.status(400).json({ error: `Unknown route: "${route}". Valid routes: stock-chart, index-chart` });
    }
  } catch (err) {
    console.error(`[charts] route=${route} error:`, err);
    return res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  }
}
