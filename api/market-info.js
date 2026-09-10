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

// ─── Date helper (NPT today as YYYY-MM-DD) ─────────────────────
function getTodayNPT() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const npt = new Date(utc + 345 * 60000); // UTC+5:45
  const yyyy = npt.getFullYear();
  const mm = String(npt.getMonth() + 1).padStart(2, '0');
  const dd = String(npt.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ─── Route dispatcher ─────────────────────────────────────────
// Routes:
//   GET /api/market-info?route=announcements&page=1&size=12
//   GET /api/market-info?route=offering&type=0&for=2&size=30
//   GET /api/market-info?route=dividend&page=1&size=20&symbol=NABIL&type=CASH
//   GET /api/market-info?route=book-close&days=30&size=50
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

      // ─── Dividend Route (Supabase) ───
      case 'dividend': {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const size = Math.min(100, Math.max(1, parseInt(req.query.size, 10) || 20));
        const from = (page - 1) * size;
        const to = from + size - 1;

        const symbol = req.query.symbol;
        const dividendType = req.query.type;
        const fiscalYear = req.query.fiscal_year;
        const status = req.query.status;
        const upcoming = req.query.upcoming === 'true';

        // ─── NEW: Sort handling ───
        const ALLOWED_SORT_COLS = [
          'symbol', 'company_name', 'dividend_type',
          'bonus_percent', 'cash_percent', 'total_percent',
          'book_close_date', 'announcement_date', 'fiscal_year', 'status'
        ];
        const sortCol = ALLOWED_SORT_COLS.includes(req.query.sort)
          ? req.query.sort
          : 'announcement_date';              // ← default sort column
        const sortOrder = req.query.order === 'asc' ? 'asc' : 'desc';

        const supabase = await getSupabaseDividendClient();

        let query = supabase
          .from('dividends')
          .select('*', { count: 'exact' })
          .order(sortCol, { ascending: sortOrder === 'asc' })
          .range(from, to);

        if (symbol) query = query.eq('symbol', symbol.toUpperCase());
        if (dividendType) query = query.eq('dividend_type', dividendType.toUpperCase());
        if (fiscalYear) query = query.eq('fiscal_year', fiscalYear);
        if (status) query = query.eq('status', status.toUpperCase());

        if (upcoming) {
          const today = new Date().toISOString().split('T')[0];
          query = query.gte('book_close_date', today);
        }

        const { data, error, count } = await query;
        if (error) throw Object.assign(new Error(error.message), { status: 500 });

        res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');

        return res.status(200).json({
          success: true,
          sort: { column: sortCol, order: sortOrder },
          data: data || [],
          pagination: {
            page,
            size,
            total: count || 0,
            totalPages: Math.ceil((count || 0) / size)
          }
        });
      }

      // ─── NEW: Upcoming Book Closures Route ───
      case 'book-close': {
        // days: look-ahead window (default: 30 days)
        // size: max records to return (default: 100)
        // include_past: if 'true', also include recent past book closures
        const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
        const size = Math.min(200, Math.max(1, parseInt(req.query.size, 10) || 100));
        const includePast = req.query.include_past === 'true';
        const symbol = req.query.symbol;

        const today = getTodayNPT();
        const futureDate = new Date(today);
        futureDate.setDate(futureDate.getDate() + days);
        const futureStr = futureDate.toISOString().split('T')[0];

        const supabase = await getSupabaseDividendClient();

        let query = supabase
          .from('dividends')
          .select('*', { count: 'exact' })
          .not('book_close_date', 'is', null)
          .order('book_close_date', { ascending: true })
          .limit(size);

        // Upcoming window: [today, today + days]
        if (!includePast) {
          query = query.gte('book_close_date', today).lte('book_close_date', futureStr);
        } else {
          // Include recent past (last 30 days) + upcoming
          const pastDate = new Date(today);
          pastDate.setDate(pastDate.getDate() - 30);
          const pastStr = pastDate.toISOString().split('T')[0];
          query = query.gte('book_close_date', pastStr).lte('book_close_date', futureStr);
        }

        if (symbol) query = query.eq('symbol', symbol.toUpperCase());

        const { data, error, count } = await query;
        if (error) throw Object.assign(new Error(error.message), { status: 500 });

        // Enrich with days-until countdown
        const todayMs = new Date(today).getTime();
        const enriched = (data || []).map(row => {
          const bookCloseMs = new Date(row.book_close_date).getTime();
          const daysUntil = Math.round((bookCloseMs - todayMs) / 86400000);
          return {
            ...row,
            days_until_book_close: daysUntil,
            is_upcoming: daysUntil >= 0,
            is_today: daysUntil === 0,
            is_tomorrow: daysUntil === 1
          };
        });

        res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');

        return res.status(200).json({
          success: true,
          filters: {
            today,
            window_end: futureStr,
            days,
            include_past: includePast,
            symbol: symbol || null
          },
          data: enriched,
          total: count || enriched.length
        });
      }

      default:
        return res.status(400).json({
          error: `Unknown route: "${route}". Valid routes: announcements, offering, dividend, book-close`
        });
    }
  } catch (err) {
    console.error(`[market-info] route=${route} error:`, err);
    return res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  }
}
