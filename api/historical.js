import { createClient } from '@supabase/supabase-js';

// All available columns in historical_technical_indicators table
const ALL_FIELDS =
  'id, symbol, date, rsi_14, macd_line, macd_signal, macd_histogram, ' +
  'atr_14, obv, close, sma_50, sma_200, ema_9, ema_21, ema_20, ema_50, ' +
  'ema_100, avg_volume_20d, volume, ad_line, anchored_vwap';

// Field presets for technical dashboard (use via ?fields=preset)
const FIELD_PRESETS = {
  volume:   'date, volume, avg_volume_20d',
  rsi:      'date, close, rsi_14',
  macd:     'date, close, macd_line, macd_signal, macd_histogram',
  ema:      'date, close, ema_9, ema_21, ema_20, ema_50, ema_100',
  sma:      'date, close, sma_50, sma_200',
  atr:      'date, close, atr_14',
  obv:      'date, close, obv',
  vwap:     'date, close, anchored_vwap',
  ad:       'date, close, ad_line',
  momentum: 'date, close, rsi_14, macd_line, macd_signal, macd_histogram, atr_14, obv',
  trend:    'date, close, sma_50, sma_200, ema_9, ema_21, ema_20, ema_50, ema_100',
  full:     ALL_FIELDS,
};

export default async function handler(req, res) {
  const ALLOWED_ORIGINS = [
    'http://localhost:5600',
    'http://localhost:5500',
    'https://nepsehub.vercel.app',
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

  // ── Query Parameters ────────────────────────────────────────────────────────
  const {
    // Core (required)
    symbol,

    // Date filters
    start_date,
    end_date,

    // Pagination
    limit = 100,
    page = 1,

    // Legacy volume-only shortcut
    volume_only,

    // Field preset / picker
    fields,           // preset name OR comma-separated column names

    // Sort direction
    sort = 'asc',     // 'asc' | 'desc'

    // Response shape modifiers
    format,           // 'flat' → raw rows without nested indicators (great for charts)
    indicators_only,  // '1' → omit price fields; return only the indicators object
    latest,           // '1' → return only the single most-recent row

    // Technical screener filters
    rsi_min,           // rsi_14 >= rsi_min
    rsi_max,           // rsi_14 <= rsi_max
    macd_signal_cross, // 'bullish' | 'bearish' (post-fetch filter)
    atr_min,           // atr_14 >= atr_min
    atr_max,           // atr_14 <= atr_max
    close_min,         // close >= close_min
    close_max,         // close <= close_max
    obv_min,           // obv >= obv_min
  } = req.query;

  if (!symbol) {
    return res.status(400).json({ error: 'Missing required parameter: symbol' });
  }

  // ── Resolve select fields ───────────────────────────────────────────────────
  const isVolumeOnly = volume_only === '1' || req.query.route === 'volume';
  let selectFields;

  if (isVolumeOnly) {
    selectFields = 'date, avg_volume_20d';
  } else if (fields) {
    if (FIELD_PRESETS[fields]) {
      selectFields = FIELD_PRESETS[fields];
    } else {
      // Custom comma-separated column list – sanitise against known columns
      const ALLOWED_COLS = new Set(ALL_FIELDS.split(',').map(c => c.trim()));
      const requested = fields.split(',').map(c => c.trim()).filter(c => ALLOWED_COLS.has(c));
      if (requested.length === 0) {
        return res.status(400).json({
          error: 'No valid columns in `fields` parameter',
          allowed_presets: Object.keys(FIELD_PRESETS),
          allowed_columns: [...ALLOWED_COLS],
        });
      }
      if (!requested.includes('date')) requested.unshift('date');
      selectFields = requested.join(', ');
    }
  } else {
    selectFields = ALL_FIELDS;
  }

  try {
    // ── Build base query ──────────────────────────────────────────────────────
    const sortAsc = sort !== 'desc';
    let query = supabase
      .from('historical_technical_indicators')
      .select(selectFields)
      .eq('symbol', symbol.toUpperCase())
      .order('date', { ascending: sortAsc });

    // Date range
    if (start_date) query = query.gte('date', start_date);
    if (end_date)   query = query.lte('date', end_date);

    // ── Technical screener filters ────────────────────────────────────────────
    if (rsi_min  !== undefined) query = query.gte('rsi_14', parseFloat(rsi_min));
    if (rsi_max  !== undefined) query = query.lte('rsi_14', parseFloat(rsi_max));
    if (atr_min  !== undefined) query = query.gte('atr_14', parseFloat(atr_min));
    if (atr_max  !== undefined) query = query.lte('atr_14', parseFloat(atr_max));
    if (close_min !== undefined) query = query.gte('close', parseFloat(close_min));
    if (close_max !== undefined) query = query.lte('close', parseFloat(close_max));
    if (obv_min  !== undefined) query = query.gte('obv',   parseFloat(obv_min));

    // ── Latest-only shortcut ──────────────────────────────────────────────────
    if (latest === '1') {
      query = query.limit(1);
      const { data, error } = await query;
      if (error) throw error;
      if (!data || data.length === 0) {
        return res.status(404).json({ error: `No data found for symbol ${symbol.toUpperCase()}` });
      }
      return res.status(200).json({ symbol: symbol.toUpperCase(), latest: true, data: data[0] });
    }

    // ── Pagination ────────────────────────────────────────────────────────────
    const limitInt = Math.min(parseInt(limit, 10) || 100, 1000);
    const pageInt  = parseInt(page, 10) || 1;
    const from = (pageInt - 1) * limitInt;
    const to   = from + limitInt - 1;
    query = query.range(from, to);

    const { data, error } = await query;
    if (error) throw error;

    if (!data || data.length === 0) {
      return res.status(404).json({
        error: `No historical data found for symbol ${symbol}`,
        symbol: symbol.toUpperCase(),
      });
    }

    // ── Total count ───────────────────────────────────────────────────────────
    let countQuery = supabase
      .from('historical_technical_indicators')
      .select('*', { count: 'exact', head: true })
      .eq('symbol', symbol.toUpperCase());
    if (start_date)   countQuery = countQuery.gte('date',   start_date);
    if (end_date)     countQuery = countQuery.lte('date',   end_date);
    if (rsi_min  !== undefined) countQuery = countQuery.gte('rsi_14', parseFloat(rsi_min));
    if (rsi_max  !== undefined) countQuery = countQuery.lte('rsi_14', parseFloat(rsi_max));
    if (atr_min  !== undefined) countQuery = countQuery.gte('atr_14', parseFloat(atr_min));
    if (atr_max  !== undefined) countQuery = countQuery.lte('atr_14', parseFloat(atr_max));
    if (close_min !== undefined) countQuery = countQuery.gte('close', parseFloat(close_min));
    if (close_max !== undefined) countQuery = countQuery.lte('close', parseFloat(close_max));
    if (obv_min  !== undefined) countQuery = countQuery.gte('obv',   parseFloat(obv_min));
    const { count: totalCount } = await countQuery;

    const pagination = {
      current_page:  pageInt,
      per_page:      limitInt,
      total_records: totalCount || 0,
      total_pages:   Math.ceil((totalCount || 0) / limitInt),
    };

    // ── format=flat → raw rows (no nesting; ideal for chart libraries) ────────
    if (format === 'flat') {
      return res.status(200).json({
        symbol: symbol.toUpperCase(),
        fields: selectFields,
        pagination,
        data,
      });
    }

    // ── volume_only mode ──────────────────────────────────────────────────────
    if (isVolumeOnly) {
      return res.status(200).json({
        symbol:     symbol.toUpperCase(),
        start_date: start_date || null,
        end_date:   end_date   || null,
        pagination,
        data: data.map(row => ({ date: row.date, avg_volume_20d: row.avg_volume_20d })),
      });
    }

    // ── Default: structured response with nested indicators ───────────────────
    let formattedData = data.map(row => {
      // MACD signal-cross post-fetch filter
      if (macd_signal_cross && row.macd_line !== undefined && row.macd_signal !== undefined) {
        const bullish = row.macd_line > row.macd_signal;
        if (macd_signal_cross === 'bullish' && !bullish) return null;
        if (macd_signal_cross === 'bearish' &&  bullish) return null;
      }

      const indicatorsObj = {
        ...(row.sma_50 !== undefined ? { sma: { sma_50: row.sma_50 ?? null, sma_200: row.sma_200 ?? null } } : {}),
        ...(row.ema_9  !== undefined
          ? { ema: { ema_9: row.ema_9 ?? null, ema_21: row.ema_21 ?? null, ema_20: row.ema_20 ?? null, ema_50: row.ema_50 ?? null, ema_100: row.ema_100 ?? null } }
          : {}),
        ...(row.rsi_14    !== undefined ? { rsi_14: row.rsi_14 } : {}),
        ...(row.macd_line !== undefined
          ? { macd: { macd_line: row.macd_line, signal_line: row.macd_signal, histogram: row.macd_histogram } }
          : {}),
        ...(row.atr_14       !== undefined ? { atr_14: row.atr_14 } : {}),
        ...(row.obv          !== undefined ? { obv: row.obv } : {}),
        ...(row.avg_volume_20d !== undefined
          ? { volume_stats: { avg_volume_20d: row.avg_volume_20d, volume: row.volume ?? null } }
          : {}),
        ...(row.ad_line       !== undefined ? { ad_line: row.ad_line } : {}),
        ...(row.anchored_vwap !== undefined ? { anchored_vwap: row.anchored_vwap } : {}),
      };

      if (indicators_only === '1') {
        return { id: row.id, symbol: row.symbol ?? symbol.toUpperCase(), date: row.date, indicators: indicatorsObj };
      }

      return {
        id:         row.id,
        symbol:     row.symbol ?? symbol.toUpperCase(),
        date:       row.date,
        close:      row.close  ?? null,
        volume:     row.volume ?? null,
        indicators: indicatorsObj,
      };
    }).filter(Boolean);

    return res.status(200).json({
      symbol:          symbol.toUpperCase(),
      start_date:      start_date || null,
      end_date:        end_date   || null,
      fields:          selectFields,
      filters_applied: buildFiltersApplied(req.query),
      pagination,
      data:            formattedData,
    });

  } catch (err) {
    console.error('Historical data error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildFiltersApplied(q) {
  const active = {};
  if (q.start_date)        active.start_date        = q.start_date;
  if (q.end_date)          active.end_date           = q.end_date;
  if (q.rsi_min)           active.rsi_min            = q.rsi_min;
  if (q.rsi_max)           active.rsi_max            = q.rsi_max;
  if (q.macd_signal_cross) active.macd_signal_cross  = q.macd_signal_cross;
  if (q.atr_min)           active.atr_min            = q.atr_min;
  if (q.atr_max)           active.atr_max            = q.atr_max;
  if (q.close_min)         active.close_min          = q.close_min;
  if (q.close_max)         active.close_max          = q.close_max;
  if (q.obv_min)           active.obv_min            = q.obv_min;
  if (q.fields)            active.fields             = q.fields;
  if (q.format)            active.format             = q.format;
  if (q.sort && q.sort !== 'asc') active.sort        = q.sort;
  return active;
}