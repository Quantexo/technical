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
  const { symbol, start_date, end_date, limit = 100, page = 1, volume_only } = req.query;

  if (!symbol) {
    return res.status(400).json({ error: 'Missing symbol parameter' });
  }

  const isVolumeOnly = volume_only === '1' || req.query.route === 'volume';

  try {
    const ALL_FIELDS = 'id, symbol, date, rsi_14, macd_line, macd_signal, macd_histogram, atr_14, obv, close, sma_50, sma_200, ema_9, ema_21, ema_20, ema_50, ema_100, avg_volume_20d, volume, ad_line, anchored_vwap';
    let selectFields = ALL_FIELDS;
    if (isVolumeOnly) {
      selectFields = 'date, avg_volume_20d';
    }

    let query = supabase
      .from('historical_technical_indicators')
      .select(selectFields)
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
    const limitInt = parseInt(limit, 10) || 100;
    const pageInt = parseInt(page, 10) || 1;
    const from = (pageInt - 1) * limitInt;
    const to = from + limitInt - 1;
    query = query.range(from, to);

    const { data, error } = await query;
    if (error) throw error;

    if (!data || data.length === 0) {
      return res.status(404).json({ 
        error: `No historical data found for symbol ${symbol}`,
        symbol: symbol.toUpperCase()
      });
    }

    // Get total count for pagination
    let countQuery = supabase
      .from('historical_technical_indicators')
      .select('*', { count: 'exact', head: true })
      .eq('symbol', symbol.toUpperCase());
    
    if (start_date) countQuery = countQuery.gte('date', start_date);
    if (end_date) countQuery = countQuery.lte('date', end_date);
    
    const { count: totalCount } = await countQuery;

    // Transform / Format response based on endpoint mode
    let formattedData;
    if (isVolumeOnly) {
      formattedData = data.map(row => ({
        date: row.date,
        avg_volume_20d: row.avg_volume_20d
      }));
    } else {
      formattedData = data.map(row => ({
        id: row.id,
        symbol: row.symbol,
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
          },
          ad_line: row.ad_line,
          anchored_vwap: row.anchored_vwap
        }
      }));
    }

    return res.status(200).json({
      symbol: symbol.toUpperCase(),
      start_date: start_date || null,
      end_date: end_date || null,
      pagination: {
        current_page: pageInt,
        per_page: limitInt,
        total_records: totalCount || 0,
        total_pages: Math.ceil((totalCount || 0) / limitInt)
      },
      data: formattedData
    });
  } catch (err) {
    console.error('Historical data error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
}