import { createClient } from '@supabase/supabase-js';

// Map sub-route to field list
const ROUTE_FIELDS = {
  'rsi': ['symbol', 'rsi_14'],
  'macd': ['symbol', 'macd_line', 'macd_signal', 'macd_histogram'],
  'crossover': [
    'symbol',
    'golden_cross_fast', 'golden_cross_slow', 'golden_cross_status', 'golden_cross_signal',
    'short_cross_fast', 'short_cross_slow', 'short_cross_status', 'short_cross_signal',
    'swing_cross_fast', 'swing_cross_slow', 'swing_cross_status', 'swing_cross_signal',
    'medium_cross_fast', 'medium_cross_slow', 'medium_cross_status', 'medium_cross_signal'
  ],
  'volume': ['symbol', 'avg_volume_20d', 'latest_volume'],
  'ad_vwap': ['symbol', 'ad_line', 'anchored_vwap'],
};

export default async function handler(req, res) {
  const ALLOWED_ORIGINS = [
    'http://localhost:5600',
    'http://localhost:5500',
    'https://nepsehub.vercel.app',
    'https://nepsehub-admin.onrender.com/',
  ];
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'Supabase credentials missing' });
  }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const route = req.query.route; // set via vercel.json rewrite
  const symbolsParam = req.query.symbols || req.query.symbol || '';
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
  const offset = parseInt(req.query.offset, 10) || 0;

  // Determine fields to select
  let fields = ['symbol', 'latest_traded_date', 'updated_at'];
  if (route && ROUTE_FIELDS[route]) {
    fields = [...new Set([...fields, ...ROUTE_FIELDS[route]])];
  } else {
    fields = ['*'];
  }

  // Parse symbols list
  const symbolsList = symbolsParam
    ? symbolsParam.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
    : [];

  try {
    let query = supabase.from('technical_indicators').select(fields.join(','));

    if (symbolsList.length > 0) {
      query = query.in('symbol', symbolsList);
    }

    query = query.order('symbol', { ascending: true });
    
    // Pagination
    query = query.range(offset, offset + limit - 1);

    const { data, error } = await query;
    if (error) throw error;

    // Get count for pagination metadata
    let countQuery = supabase
      .from('technical_indicators')
      .select('symbol', { count: 'exact', head: true });
      
    if (symbolsList.length > 0) {
      countQuery = countQuery.in('symbol', symbolsList);
    }
    
    const { count: totalCount, error: countError } = await countQuery;
    if (countError) throw countError;

    return res.status(200).json({
      success: true,
      pagination: {
        offset,
        limit,
        total: totalCount || 0,
        next_offset: (offset + limit) < (totalCount || 0) ? offset + limit : null,
      },
      data,
    });
  } catch (err) {
    console.error('Indicators API error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
}
