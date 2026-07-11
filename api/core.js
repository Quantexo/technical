// ─── CORS helper ─────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
}

async function proxy(url, headers = {}) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', ...headers }
  });
  if (!response.ok) throw Object.assign(new Error('Upstream error'), { status: response.status });
  return response.json();
}

// ─── Route dispatcher ─────────────────────────────────────────
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const route = req.query.route;

  try {
    switch (route) {
      case 'live-nepse': {
        const data = await proxy('https://nepselytics-6d61dea19f30.herokuapp.com/api/nepselytics/live-nepse');
        return res.status(200).json(data);
      }

      case 'market-turnover': {
        const data = await proxy('https://tms59.nepsetms.com.np/tmsapi/rtApi/admin/vCache/marketTurnover');
        return res.status(200).json(data);
      }

      case 'index-live': {
        const ts = Date.now();
        const data = await proxy(`https://nepalipaisa.com/api/GetIndexLive?_=${ts}`, { Referer: 'https://nepalipaisa.com' });
        return res.status(200).json(data);
      }

      case 'subindex-live': {
        const ts = Date.now();
        const data = await proxy(`https://nepalipaisa.com/api/GetSubIndexLive?_=${ts}`, { Referer: 'https://nepalipaisa.com' });
        return res.status(200).json(data);
      }

      case 'homepage-data': {
        const data = await proxy('https://sharehubnepal.com/live/api/v2/nepselive/home-page-data');
        return res.status(200).json(data);
      }

      case 'floorsheet': {
        const page = Math.max(0, parseInt(req.query.page, 10) || 0);
        const size = Math.min(500, Math.max(1, parseInt(req.query.size, 10) || 500));
        const order = req.query.order === 'asc' ? 'asc' : 'desc';
        const base = 'https://nepselytics-6d61dea19f30.herokuapp.com/api/nepselytics/floorsheet';

        if (size > 100) {
          const allRecords = [];
          const pagesNeeded = Math.ceil(size / 100);
          for (let i = 0; i < pagesNeeded; i++) {
            const resp = await fetch(`${base}?page=${page + i}&Size=100&order=${order}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
            if (!resp.ok) break;
            const result = await resp.json();
            const records = result.data?.content || [];
            allRecords.push(...records);
            if (records.length < 100) break;
          }
          return res.status(200).json({ success: true, data: allRecords.slice(0, size) });
        } else {
          const resp = await fetch(`${base}?page=${page}&Size=${size}&order=${order}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
          if (!resp.ok) return res.status(resp.status).json({ error: 'Failed to fetch floorsheet' });
          return res.status(200).json(await resp.json());
        }
      }

      case 'floorsheet-totals': {
        const data = await proxy('https://nepselytics-6d61dea19f30.herokuapp.com/api/nepselytics/floorsheet/totals');
        return res.status(200).json(data);
      }

      default:
        return res.status(400).json({ error: `Unknown route: "${route}". Valid routes: live-nepse, market-turnover, index-live, subindex-live, homepage-data, floorsheet, floorsheet-totals` });
    }
  } catch (err) {
    console.error(`[core] route=${route} error:`, err);
    return res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  }
}
