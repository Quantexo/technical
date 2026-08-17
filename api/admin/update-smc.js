import { createClient } from '@supabase/supabase-js';

// ------------------------------------------------------------
// Helper: convert Date to ISO string for Supabase
// ------------------------------------------------------------
function toISO(date) {
  return date instanceof Date ? date.toISOString() : date;
}

// ------------------------------------------------------------
// Detect Swing Highs and Lows (needed for OB detection)
// ------------------------------------------------------------
function detectSwings(symbol, df) {
  const swings = [];
  const windowSize = 5;
  for (let i = windowSize; i < df.length - windowSize; i++) {
    const current = df[i];
    const left = df.slice(i - windowSize, i);
    const right = df.slice(i + 1, i + windowSize + 1);

    const leftHighs = left.map(c => c.high);
    const rightHighs = right.map(c => c.high);
    if (current.high > Math.max(...leftHighs) && current.high > Math.max(...rightHighs)) {
      swings.push({ symbol, timestamp: toISO(current.time), price: current.high, swing_type: 'high' });
    }

    const leftLows = left.map(c => c.low);
    const rightLows = right.map(c => c.low);
    if (current.low < Math.min(...leftLows) && current.low < Math.min(...rightLows)) {
      swings.push({ symbol, timestamp: toISO(current.time), price: current.low, swing_type: 'low' });
    }
  }
  return swings;
}

// ------------------------------------------------------------
// Detect Order Blocks (OB)
// ------------------------------------------------------------
function detectOrderBlocks(symbol, df, swings) {
  const obs = [];
  const avgRange = df.reduce((sum, c) => sum + (c.high - c.low), 0) / df.length;

  for (const swing of swings) {
    const swingIdx = df.findIndex(c => toISO(c.time) === swing.timestamp);
    if (swingIdx < 0) continue;

    const start = Math.max(0, swingIdx - 10);
    for (let i = swingIdx - 1; i >= start; i--) {
      const candle = df[i];
      const range = candle.high - candle.low;
      if (range < 1.5 * avgRange) continue;

      if (swing.swing_type === 'high' && candle.close > candle.open) {
        obs.push({
          symbol,
          timestamp: toISO(candle.time),
          high: candle.high,
          low: candle.low,
          ob_type: 'bearish'
        });
        break;
      } else if (swing.swing_type === 'low' && candle.close < candle.open) {
        obs.push({
          symbol,
          timestamp: toISO(candle.time),
          high: candle.high,
          low: candle.low,
          ob_type: 'bullish'
        });
        break;
      }
    }
  }
  return obs;
}

// ------------------------------------------------------------
// Main Handler – supports offset & limit for symbol batching
// ------------------------------------------------------------
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Authentication: use ADMIN_SECRET_KEY environment variable
  const secret = req.query.secret;
  const expectedSecret = process.env.ADMIN_SECRET_KEY;
  if (!expectedSecret || !secret || secret !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing ADMIN_SECRET_KEY' });
  }

  // Pagination parameters
  const offset = parseInt(req.query.offset) || 0;
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.error('Missing Supabase credentials');
    return res.status(500).json({ error: 'Supabase credentials missing' });
  }
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    // 1. Get all distinct symbols (paginated)
    let allRows = [];
    let from = 0;
    const pageSize = 1000;
    let hasMore = true;
    while (hasMore) {
      const { data, error } = await supabase
        .from('prices')
        .select('symbol')
        .range(from, from + pageSize - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      allRows.push(...data);
      if (data.length < pageSize) hasMore = false;
      from += pageSize;
    }
    const uniqueSymbols = [...new Set(allRows.map(r => r.symbol))].sort();
    const totalSymbols = uniqueSymbols.length;

    // 2. Slice the batch
    const symbolsToProcess = uniqueSymbols.slice(offset, offset + limit);
    if (symbolsToProcess.length === 0) {
      return res.status(200).json({
        message: 'No more symbols to process',
        total_symbols: totalSymbols,
        processed: 0,
        next_offset: offset,
      });
    }

    // 3. Process each symbol sequentially
    const results = [];
    for (const sym of symbolsToProcess) {
      try {
        // Fetch all data for this symbol (paginated)
        let allData = [];
        let from = 0;
        const pageSize = 1000;
        let hasMore = true;
        while (hasMore) {
          const { data, error } = await supabase
            .from('prices')
            .select('date, open, high, low, close, volume')
            .eq('symbol', sym)
            .order('date', { ascending: true })
            .range(from, from + pageSize - 1);
          if (error) throw error;
          if (!data || data.length === 0) break;
          allData.push(...data);
          if (data.length < pageSize) hasMore = false;
          from += pageSize;
        }

        if (allData.length < 10) {
          results.push({ symbol: sym, status: 'skipped', reason: 'insufficient data' });
          continue;
        }

        // Convert to DataFrame format
        const df = allData.map(d => ({
          time: new Date(d.date),
          open: parseFloat(d.open),
          high: parseFloat(d.high),
          low: parseFloat(d.low),
          close: parseFloat(d.close),
          volume: parseInt(d.volume, 10)
        }));

        // Detect swings first (needed for OB)
        const swings = detectSwings(sym, df);

        // Detect Order Blocks
        const obs = detectOrderBlocks(sym, df, swings);

        // Upsert OB into Supabase
        if (obs.length) {
          await supabase.from('smc_order_blocks').upsert(obs, { onConflict: 'symbol, timestamp' });
        }

        results.push({
          symbol: sym,
          status: 'success',
          counts: { swings: swings.length, obs: obs.length }
        });
      } catch (err) {
        console.error(`Error processing ${sym}:`, err);
        results.push({ symbol: sym, status: 'failed', error: err.message });
      }
      console.log(`Processed ${sym} (${results.length}/${symbolsToProcess.length})`);
    }

    const nextOffset = offset + symbolsToProcess.length;
    return res.status(200).json({
      message: 'SMC OB batch processed',
      total_symbols: totalSymbols,
      processed_symbols: symbolsToProcess.length,
      next_offset: nextOffset,
      results,
    });
  } catch (err) {
    console.error('SMC update error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
}