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

// ─── Supabase Client Factory (cached) ──────────────────────────
let _supabaseDivClient = null;

async function getSupabaseDividendClient() {
  if (_supabaseDivClient) return _supabaseDivClient;

  const { createClient } = await import('@supabase/supabase-js');
  const url = process.env.SUPABASE_URL_3;
  const key = process.env.SUPABASE_ANON_KEY_3;

  if (!url || !key) {
    throw Object.assign(
      new Error('Missing SUPABASE_URL_3 or SUPABASE_ANON_KEY_3'),
      { status: 500 }
    );
  }

  _supabaseDivClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  return _supabaseDivClient;
}

// ─── Route dispatcher ─────────────────────────────────────────
// Routes:
//   GET /api/market-info?route=announcements&page=1&size=12
//   GET /api/market-info?route=offering&type=0&for=2&size=30
//   GET /api/market-info?route=dividend&page=1&size=20&symbol=NABIL&type=CASH&fiscal_year=2082/83
export default async function handler(req, res) {
  cors(req, res);
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

      // ─── NEW: Dividend Route (Supabase) ───
      case 'dividend': {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const size = Math.min(100, Math.max(1, parseInt(req.query.size, 10) || 20));
        const from = (page - 1) * size;
        const to = from + size - 1;

        const symbol = req.query.symbol;
        const dividendType = req.query.type;
        const fiscalYear = req.query.fiscal_year;
        const status = req.query.status;

        const supabase = await getSupabaseDividendClient();

        let query = supabase
          .from('dividends')                                // ← your table name
          .select('*', { count: 'exact' })
          .order('announcement_date', { ascending: false })
          .range(from, to);

        // Optional filters
        if (symbol) query = query.eq('symbol', symbol.toUpperCase());
        if (dividendType) query = query.eq('dividend_type', dividendType.toUpperCase());
        if (fiscalYear) query = query.eq('fiscal_year', fiscalYear);
        if (status) query = query.eq('status', status.toUpperCase());

        const { data, error, count } = await query;

        if (error) throw Object.assign(new Error(error.message), { status: 500 });

        // Cache for 5 minutes (dividends don't change often)
        res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');

        return res.status(200).json({
          success: true,
          data: data || [],
          pagination: {
            page,
            size,
            total: count || 0,
            totalPages: Math.ceil((count || 0) / size)
          }
        });
      }

      default:
        return res.status(400).json({
          error: `Unknown route: "${route}". Valid routes: announcements, offering, dividend`
        });
    }
  } catch (err) {
    console.error(`[market-info] route=${route} error:`, err);
    return res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  }
}
