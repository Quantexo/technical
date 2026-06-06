import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'Supabase credentials missing' });
  }
  const supabase = createClient(supabaseUrl, supabaseKey);

  // Get query parameters
  const { symbol, start_date, end_date, limit = 100, page = 1 } = req.query;

  if (!symbol) {
    return res.status(400).json({ error: 'Missing symbol parameter' });
  }

  try {
    let query = supabase
      .from('historical_technical_indicators')
      .select('*')
      .eq('symbol', symbol.toUpperCase())
      .order('date', { ascending: true });

    // Apply date filters if provided
    if (start_date) {
      query = query.gte('date', start_date);
    }
    if (end_date) {
      query = query.lte('date', end_date);
    }

    // Apply pagination
    const from = (parseInt(page) - 1) * parseInt(limit);
    const to = from + parseInt(limit) - 1;
    query = query.range(from, to);

    const { data, error, count } = await query;
    if (error) throw error;

    if (!data || data.length === 0) {
      return res.status(404).json({ 
        error: `No historical data found for symbol ${symbol}`,
        symbol: symbol.toUpperCase(),
        start_date: start_date || null,
        end_date: end_date || null
      });
    }

    // Transform data into a clean format
    const formattedData = data.map(row => ({
      date: row.date,
      close: row.close,
      volume: row.volume,
      indicators: {
        sma: {
          sma_50: row.sma_50,
          sma_200: row.sma_200
        },
        ema: {
          ema_9: row.ema_9,
          ema_21: row.ema_21,
          ema_20: row.ema_20,
          ema_50: row.ema_50,
          ema_100: row.ema_100
        },
        rsi_14: row.rsi_14,
        macd: {
          macd_line: row.macd_line,
          signal_line: row.macd_signal,
          histogram: row.macd_histogram
        },
        atr_14: row.atr_14,
        obv: row.obv,
        volume_stats: {
          avg_volume_20d: row.avg_volume_20d,
          volume: row.volume
        }
      }
    }));

    // Get total count for pagination
    let countQuery = supabase
      .from('historical_technical_indicators')
      .select('*', { count: 'exact', head: true })
      .eq('symbol', symbol.toUpperCase());
    
    if (start_date) countQuery = countQuery.gte('date', start_date);
    if (end_date) countQuery = countQuery.lte('date', end_date);
    
    const { count: totalCount } = await countQuery;

    return res.status(200).json({
      symbol: symbol.toUpperCase(),
      start_date: start_date || null,
      end_date: end_date || null,
      pagination: {
        current_page: parseInt(page),
        per_page: parseInt(limit),
        total_records: totalCount || 0,
        total_pages: Math.ceil((totalCount || 0) / parseInt(limit))
      },
      data: formattedData
    });
  } catch (err) {
    console.error('Historical data error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
}