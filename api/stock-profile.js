const NEPSELYTICS = 'https://nepselytics-6d61dea19f30.herokuapp.com/api/nepselytics';
const SHAREHUB = 'https://sharehubnepal.com';

// Richer headers that mimic a browser request — Heroku backend requires these
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://nepselytics.app',
  'Referer': 'https://nepselytics.app/',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache'
};

// ─── CORS helper ─────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'http://localhost:5600',
  'http://localhost:5500',
  'https://nepsehub.vercel.app',
  'https://nepsehub-admin.onrender.com/',
];

function cors(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}

async function proxy(url) {
  const response = await fetch(url, { headers: HEADERS });
  if (!response.ok) throw Object.assign(new Error(`Upstream ${response.status} for ${url}`), { status: response.status });
  return response.json();
}

// ─── Route dispatcher ─────────────────────────────────────────
// Routes:
//   GET /api/stock-profile?route=profile&symbol=XYZ
//   GET /api/stock-profile?route=alpha-beta&symbol=XYZ
//   GET /api/stock-profile?route=broker-top-holding&symbol=XYZ&days=1
//   GET /api/stock-profile?route=broker-snapshot   (no symbol)
//   GET /api/stock-profile?route=market-depth&symbol=XYZ
//   GET /api/stock-profile?route=report&symbol=XYZ
//   GET /api/stock-profile?route=floorsheet&symbol=XYZ&page=0&size=50
//   GET /api/stock-profile?route=top-buy&symbol=XYZ&from_date=YYYY-MM-DD&to_date=YYYY-MM-DD
//   GET /api/stock-profile?route=top-sell&symbol=XYZ&from_date=YYYY-MM-DD&to_date=YYYY-MM-DD
export default async function handler(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const route = req.query.route || 'profile';
  const { symbol, days = 1, page = 0, size = 50, from_date, to_date } = req.query;

  // Routes that require a symbol
  const requiresSymbol = ['profile', 'alpha-beta', 'broker-top-holding', 'market-depth', 'report',
                          'floorsheet', 'top-buy', 'top-sell'];
  if (requiresSymbol.includes(route) && !symbol) {
    return res.status(400).json({ error: 'symbol parameter is required' });
  }

  const sym = symbol ? symbol.toUpperCase() : null;

  // Default date helpers
  const today = new Date().toISOString().split('T')[0];
  const fromDate = from_date || today;
  const toDate   = to_date   || today;

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
        const stock = Array.isArray(stocks)
          ? stocks.find(s => s.symbol && s.symbol.toUpperCase() === sym)
          : null;
        if (!stock) {
          return res.status(404).json({ error: `Stock ID not found for symbol: ${sym}` });
        }
        // Step 2: fetch report by ID
        return res.status(200).json(
          await proxy(`${NEPSELYTICS}/stock-report/${stock.id}`)
        );
      }

      case 'floorsheet': {
        return res.status(200).json(
          await proxy(`${NEPSELYTICS}/floorsheet?page=${page}&Size=${size}&symbol=${sym}`)
        );
      }

      case 'top-buy': {
        return res.status(200).json(
          await proxy(`${NEPSELYTICS}/top-buy?symbol=${sym}&from_date=${fromDate}&to_date=${toDate}`)
        );
      }

      case 'top-sell': {
        return res.status(200).json(
          await proxy(`${NEPSELYTICS}/top-sell?symbol=${sym}&from_date=${fromDate}&to_date=${toDate}`)
        );
      }

      default:
        return res.status(400).json({
          error: `Unknown route: "${route}". Valid routes: profile, alpha-beta, broker-top-holding, broker-snapshot, market-depth, report, floorsheet, top-buy, top-sell`
        });
    }
  } catch (err) {
    console.warn(`[stock-profile] Upstream error for route="${route}":`, err.message);

    // Graceful fallbacks so frontend can use its built-in deterministic fallbacks
    const fallbacks = {
      'profile':            {},
      'alpha-beta':         { value: [] },
      'broker-top-holding': [],
      'broker-snapshot':    [],
      'market-depth':       {},
      'report':             [],
      'floorsheet':         { data: [], totalElements: 0 },
      'top-buy':            [],
      'top-sell':           []
    };

    return res.status(200).json(fallbacks[route] ?? {});
  }
}
