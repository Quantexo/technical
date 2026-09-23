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

// ─── Bulk Transactions Selected Columns ───────────────────────────
// Explicit projection: strictly excludes 'id', 'source', and 'created_at'
const BULK_TRANSACTION_FIELDS = [
  'contract_id',
  'symbol',
  'name',
  'buyer_member_id',
  'seller_member_id',
  'contract_quantity',
  'contract_rate',
  'contract_amount',
  'business_date',
  'trade_time'
].join(',');

// Cached Supabase clients
let _supabaseClient1 = null;
let _supabaseClient3 = null;

function getSupabaseIndicatorsClient() {
  if (_supabaseClient1) return _supabaseClient1;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
  if (!url || !key) {
    throw Object.assign(new Error('Supabase credentials missing (SUPABASE_URL or SUPABASE_ANON_KEY/SERVICE_ROLE)'), { status: 500 });
  }
  _supabaseClient1 = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  return _supabaseClient1;
}

function getSupabaseBulkClient() {
  if (_supabaseClient3) return _supabaseClient3;
  const url = process.env.SUPABASE_URL_3;
  const key = process.env.SUPABASE_ANON_KEY_3 || process.env.SUPABASE_SERVICE_ROLE_KEY_3 || process.env.SUPABASE_KEY_3;
  if (!url || !key) {
    throw Object.assign(new Error('Missing SUPABASE_URL_3 or SUPABASE_ANON_KEY_3 environment variables'), { status: 500 });
  }
  _supabaseClient3 = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
  return _supabaseClient3;
}

async function handleBulkTransactions(req, res) {
  const supabase = getSupabaseBulkClient();

  const symbol = (req.query.symbol || '').trim().toUpperCase();
  const symbolsParam = req.query.symbols || '';
  const symbolsList = symbolsParam
    ? symbolsParam.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
    : (symbol ? [symbol] : []);

  const businessDate = req.query.business_date || req.query.date;
  const fromDate = req.query.from_date || req.query.start_date;
  const toDate = req.query.to_date || req.query.end_date;

  const buyerId = req.query.buyer_member_id || req.query.buyer;
  const sellerId = req.query.seller_member_id || req.query.seller;
  const brokerId = req.query.broker;

  const minAmount = parseFloat(req.query.min_amount);
  const maxAmount = parseFloat(req.query.max_amount);
  const minQty = parseInt(req.query.min_quantity || req.query.min_qty, 10);
  const maxQty = parseInt(req.query.max_quantity || req.query.max_qty, 10);

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit || req.query.size, 10) || 50));
  const offset = req.query.offset !== undefined
    ? Math.max(0, parseInt(req.query.offset, 10) || 0)
    : (page - 1) * limit;

  // Allowed columns for sorting (strictly from the projected columns)
  const ALLOWED_SORT_COLS = [
    'contract_id',
    'symbol',
    'name',
    'buyer_member_id',
    'seller_member_id',
    'contract_quantity',
    'contract_rate',
    'contract_amount',
    'business_date',
    'trade_time'
  ];
  const requestedSort = (req.query.sort || '').toLowerCase().trim();
  const sortCol = ALLOWED_SORT_COLS.includes(requestedSort) ? requestedSort : null;
  const sortOrder = (req.query.order || '').toLowerCase().trim() === 'asc' ? 'asc' : 'desc';

  // Build query - only select allowed columns, never id, source, or created_at
  let query = supabase
    .from('bulk_transactions')
    .select(BULK_TRANSACTION_FIELDS, { count: 'exact' });

  // Symbol filtering
  if (symbolsList.length === 1) {
    query = query.eq('symbol', symbolsList[0]);
  } else if (symbolsList.length > 1) {
    query = query.in('symbol', symbolsList);
  }

  // Date filtering
  if (businessDate) {
    query = query.eq('business_date', businessDate);
  } else {
    if (fromDate) query = query.gte('business_date', fromDate);
    if (toDate) query = query.lte('business_date', toDate);
  }

  // Broker filtering
  if (brokerId) {
    const bId = parseInt(brokerId, 10);
    if (!isNaN(bId)) {
      query = query.or(`buyer_member_id.eq.${bId},seller_member_id.eq.${bId}`);
    }
  } else {
    if (buyerId) {
      const bId = parseInt(buyerId, 10);
      if (!isNaN(bId)) query = query.eq('buyer_member_id', bId);
    }
    if (sellerId) {
      const sId = parseInt(sellerId, 10);
      if (!isNaN(sId)) query = query.eq('seller_member_id', sId);
    }
  }

  // Amount & quantity filters
  if (!isNaN(minAmount)) query = query.gte('contract_amount', minAmount);
  if (!isNaN(maxAmount)) query = query.lte('contract_amount', maxAmount);
  if (!isNaN(minQty)) query = query.gte('contract_quantity', minQty);
  if (!isNaN(maxQty)) query = query.lte('contract_quantity', maxQty);

  // Sorting
  if (sortCol) {
    query = query.order(sortCol, { ascending: sortOrder === 'asc' });
  } else {
    query = query
      .order('business_date', { ascending: false })
      .order('trade_time', { ascending: false, nullsFirst: false });
  }

  // Pagination range
  query = query.range(offset, offset + limit - 1);

  const { data, count, error } = await query;
  if (error) throw error;

  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120');

  return res.status(200).json({
    success: true,
    pagination: {
      page: Math.floor(offset / limit) + 1,
      limit,
      offset,
      total: count || 0,
      totalPages: Math.ceil((count || 0) / limit),
      has_next: (offset + limit) < (count || 0)
    },
    data: data || []
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const route = (req.query.route || '').toLowerCase().trim();

  try {
    // ─── Bulk Transactions Route ──────────────────────────────────
    if (['bulk-transactions', 'bulk_transactions', 'bulk-transaction', 'bulk_transaction'].includes(route)) {
      return await handleBulkTransactions(req, res);
    }

    // ─── Technical Indicators Routes ──────────────────────────────
    const supabase = getSupabaseIndicatorsClient();

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
    return res.status(err.status || 500).json({
      success: false,
      error: err.message || 'Internal server error'
    });
  }
}

