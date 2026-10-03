// ─── CORS helper (Public Developer Access) ─────────────────────
function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Max-Age', '86400');
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
  cors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const route = req.query.route;

  try {
    switch (route) {
      case 'live-nepse': {
        const data = await proxy('https://sharehubnepal.com/live/api/v2/nepselive/home-page-data');
        const stocks = data?.liveCompanyData || [];
        return res.status(200).json(stocks);
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
        const page = req.query.page !== undefined ? Math.max(1, parseInt(req.query.page, 10) || 1) : 1;
        const size = Math.min(500, Math.max(1, parseInt(req.query.size || req.query.Size, 10) || 100));
        const order = req.query.order === 'asc' ? 'asc' : 'desc';
        const symbol = (req.query.Symbol || req.query.symbol || '').trim();
        const buyerId = (req.query.BuyerId || req.query.buyerId || req.query.buyer || '').trim().replace(/^B-?/i, '');
        const sellerId = (req.query.SellerId || req.query.sellerId || req.query.seller || '').trim().replace(/^S-?/i, '');

        const buildUrl = (p, s) => {
          let u = `https://sharehubnepal.com/live/api/v2/floorsheet?Size=${s}&page=${p}&currentPage=${p}&order=${order}`;
          if (symbol) u += `&Symbol=${encodeURIComponent(symbol.toUpperCase())}`;
          if (buyerId) u += `&BuyerId=${encodeURIComponent(buyerId)}`;
          if (sellerId) u += `&SellerId=${encodeURIComponent(sellerId)}`;
          return u;
        };

        if (size > 100) {
          const allRecords = [];
          const pagesNeeded = Math.ceil(size / 100);
          let firstPageData = null;

          for (let i = 0; i < pagesNeeded; i++) {
            const resp = await fetch(buildUrl(page + i, 100), { headers: { 'User-Agent': 'Mozilla/5.0' } });
            if (!resp.ok) break;
            const result = await resp.json();
            if (!firstPageData && result?.data) {
              firstPageData = result.data;
            }
            const records = result?.data?.content || [];
            allRecords.push(...records);
            if (records.length < 100) break;
          }

          return res.status(200).json({
            success: true,
            code: null,
            message: null,
            data: {
              totalAmount: firstPageData?.totalAmount || 0,
              totalQty: firstPageData?.totalQty || 0,
              totalTrades: firstPageData?.totalTrades || firstPageData?.totalItems || allRecords.length,
              pageIndex: page,
              totalPages: Math.ceil((firstPageData?.totalItems || allRecords.length) / size) || 1,
              totalItems: firstPageData?.totalItems || allRecords.length,
              pageSize: size,
              content: allRecords.slice(0, size)
            }
          });
        } else {
          const resp = await fetch(buildUrl(page, size), { headers: { 'User-Agent': 'Mozilla/5.0' } });
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
