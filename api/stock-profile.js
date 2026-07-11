const NEPSELYTICS = 'https://nepselytics-6d61dea19f30.herokuapp.com/api/nepselytics';
const SHAREHUB = 'https://sharehubnepal.com';
const HEADERS = { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' };

// ─── CORS helper ─────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
}

async function proxy(url) {
  const response = await fetch(url, { headers: HEADERS });
  if (!response.ok) throw Object.assign(new Error('Upstream error'), { status: response.status });
  return response.json();
}

// ─── Route dispatcher ─────────────────────────────────────────
// Routes (all require ?symbol=XYZ unless noted):
//   GET /api/stock-profile?route=profile&symbol=XYZ
//   GET /api/stock-profile?route=alpha-beta&symbol=XYZ
//   GET /api/stock-profile?route=broker-top-holding&symbol=XYZ&days=1
//   GET /api/stock-profile?route=broker-snapshot   (no symbol)
//   GET /api/stock-profile?route=market-depth&symbol=XYZ
//   GET /api/stock-profile?route=report&symbol=XYZ
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const route = req.query.route || 'profile';
  const { symbol, days = 1 } = req.query;

  // Routes that require a symbol
  const requiresSymbol = ['profile', 'alpha-beta', 'broker-top-holding', 'market-depth', 'report'];
  if (requiresSymbol.includes(route) && !symbol) {
    return res.status(400).json({ error: 'symbol parameter is required' });
  }

  const sym = symbol ? symbol.toUpperCase() : null;

  try {
    switch (route) {
      case 'profile': {
        return res.status(200).json(
          await proxy(`${NEPSELYTICS}/stock-profile?symbol=${sym}`)
        );
      }

      case 'alpha-beta': {
        return res.status(200).json(
          await proxy(`${NEPSELYTICS}/alpha-beta?symbol=${sym}`)
        );
      }

      case 'broker-top-holding': {
        return res.status(200).json(
          await proxy(`${NEPSELYTICS}/broker-top-holding?symbol=${sym}&days=${days}`)
        );
      }

      case 'broker-snapshot': {
        return res.status(200).json(
          await proxy(`${NEPSELYTICS}/broker-snapshot`)
        );
      }

      case 'market-depth': {
        return res.status(200).json(
          await proxy(`${SHAREHUB}/live/api/v2/nepselive/market-depth/${sym}`)
        );
      }

      case 'report': {
        // Step 1: resolve symbol → stock ID
        const stocks = await proxy(`${NEPSELYTICS}/stock-list`);
        const stock = stocks.find(s => s.symbol && s.symbol.toUpperCase() === sym);
        if (!stock) {
          return res.status(404).json({ error: `Stock ID not found for symbol: ${sym}` });
        }
        // Step 2: fetch report by ID
        const reportData = await proxy(`${NEPSELYTICS}/stock-report/${stock.id}`);
        return res.status(200).json(reportData);
      }

      default:
        return res.status(400).json({
          error: `Unknown route: "${route}". Valid routes: profile, alpha-beta, broker-top-holding, broker-snapshot, market-depth, report`
        });
    }
  } catch (err) {
    console.error(`[stock-profile] route=${route} error:`, err);
    return res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  }
}
