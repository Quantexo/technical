// ─── CORS helper ─────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
}

async function proxy(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!response.ok) throw Object.assign(new Error('Upstream error'), { status: response.status });
  return response.json();
}

// ─── Route dispatcher ─────────────────────────────────────────
// Routes:
//   GET /api/market-info?route=announcements&page=1&size=12
//   GET /api/market-info?route=offering&type=0&for=2&size=30
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const route = req.query.route;

  try {
    switch (route) {
      case 'announcements': {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const size = Math.min(100, Math.max(1, parseInt(req.query.size, 10) || 12));
        const url = `https://sharehubnepal.com/data/api/v1/announcement?Page=${page}&Size=${size}`;
        return res.status(200).json(await proxy(url));
      }

      case 'offering': {
        const type = req.query.type;
        const forCategory = req.query.for;
        const size = Math.min(100, Math.max(1, parseInt(req.query.size, 10) || 30));

        if (type === undefined || forCategory === undefined) {
          return res.status(400).json({ error: 'Missing type or for parameter' });
        }
        const url = `https://sharehubnepal.com/data/api/v1/public-offering?size=${size}&type=${type}&for=${forCategory}`;
        return res.status(200).json(await proxy(url));
      }

      default:
        return res.status(400).json({
          error: `Unknown route: "${route}". Valid routes: announcements, offering`
        });
    }
  } catch (err) {
    console.error(`[market-info] route=${route} error:`, err);
    return res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  }
}
