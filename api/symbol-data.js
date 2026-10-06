import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  // ─── CORS HEADERS (Public Developer Access) ─────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Max-Age', '86400');

  // ─── HANDLE OPTIONS (Preflight) ────────────────────────────────────
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ─── MAIN REQUEST HANDLING ────────────────────────────────────────
  const { symbol, start_date, end_date, route } = req.query;

  if (!symbol) {
    return res.status(400).json({ error: 'Missing symbol parameter' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
  
  if (!supabaseUrl || !supabaseKey) {
    console.error('❌ Supabase credentials missing');
    return res.status(500).json({ error: 'Supabase credentials missing' });
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseKey);
    const symbolUpper = symbol.trim().toUpperCase();
    const isChartRoute = route && (route.toLowerCase() === 'charts' || route.toLowerCase() === 'chart');

    let rawData = [];

    if (isChartRoute) {
      // ─── ROUTE: CHARTS (Load all available rows for the symbol) ─────────
      let from = 0;
      const pageSize = 1000;
      let hasMore = true;

      while (hasMore) {
        let chartQuery = supabase
          .from('prices')
          .select('date, open, high, low, close, volume')
          .eq('symbol', symbolUpper)
          .order('date', { ascending: true })
          .range(from, from + pageSize - 1);

        if (start_date && start_date.toLowerCase() !== 'all') {
          chartQuery = chartQuery.gte('date', start_date);
        }
        if (end_date) {
          chartQuery = chartQuery.lte('date', end_date);
        }

        const { data, error } = await chartQuery;
        if (error) {
          console.error('❌ Supabase query error:', error);
          throw error;
        }

        if (!data || data.length === 0) break;
        rawData.push(...data);
        if (data.length < pageSize) {
          hasMore = false;
        }
        from += pageSize;
        if (from >= 50000) break;
      }
    } else {
      // ─── DEFAULT ROUTE (Standard symbol data, last 1 year by default) ───
      const limitNum = Math.min(parseInt(req.query.limit, 10) || 10000, 50000);
      
      let query = supabase
        .from('prices')
        .select('date, open, high, low, close, volume')
        .eq('symbol', symbolUpper)
        .order('date', { ascending: true })
        .limit(limitNum);

      // Apply date filters
      if (start_date && start_date.toLowerCase() !== 'all') {
        query = query.gte('date', start_date);
      } else if (!start_date && req.query.all !== 'true') {
        // Default to last 1 year if start_date is not specified
        const oneYearAgo = new Date();
        oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
        const formattedDate = oneYearAgo.toISOString().split('T')[0];
        query = query.gte('date', formattedDate);
      }

      if (end_date) {
        query = query.lte('date', end_date);
      }

      const { data, error } = await query;
      
      if (error) {
        console.error('❌ Supabase query error:', error);
        throw error;
      }
      rawData = data || [];
    }

    const mappedCandles = rawData.map(d => ({
      Date: d.date,
      Open: parseFloat(d.open || 0),
      High: parseFloat(d.high || 0),
      Low: parseFloat(d.low || 0),
      Close: parseFloat(d.close || 0),
      Volume: parseInt(d.volume || 0, 10)
    }));

    return res.status(200).json({
      success: true,
      route: isChartRoute ? 'charts' : 'default',
      symbol: symbolUpper,
      count: mappedCandles.length,
      data: mappedCandles
    });

  } catch (err) {
    console.error('❌ Symbol-data error:', err);
    return res.status(500).json({ 
      error: 'Internal server error', 
      details: err.message 
    });
  }
}
