import { createClient } from '@supabase/supabase-js';

// ------------------------------------------------------------
// SMC Detection Functions (same as before)
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
      swings.push({ symbol, timestamp: current.time, price: current.high, swing_type: 'high' });
    }

    const leftLows = left.map(c => c.low);
    const rightLows = right.map(c => c.low);
    if (current.low < Math.min(...leftLows) && current.low < Math.min(...rightLows)) {
      swings.push({ symbol, timestamp: current.time, price: current.low, swing_type: 'low' });
    }
  }
  return swings;
}

function detectFVG(symbol, df) {
  const fvgs = [];
  const lookback = 3;
  for (let i = lookback; i < df.length; i++) {
    const current = df[i];
    const previous = df[i - lookback];
    if (current.low > previous.high) {
      fvgs.push({
        symbol,
        start_time: previous.time,
        end_time: current.time,
        high: current.low,
        low: previous.high,
        fvg_type: 'bullish'
      });
    } else if (current.high < previous.low) {
      fvgs.push({
        symbol,
        start_time: previous.time,
        end_time: current.time,
        high: previous.low,
        low: current.high,
        fvg_type: 'bearish'
      });
    }
  }
  return fvgs;
}

function detectOrderBlocks(symbol, df, swings) {
  const obs = [];
  const avgRange = df.reduce((sum, c) => sum + (c.high - c.low), 0) / df.length;

  for (const swing of swings) {
    const swingIdx = df.findIndex(c => c.time === swing.timestamp);
    if (swingIdx < 0) continue;

    const start = Math.max(0, swingIdx - 10);
    for (let i = swingIdx - 1; i >= start; i--) {
      const candle = df[i];
      const range = candle.high - candle.low;
      if (range < 1.5 * avgRange) continue;

      if (swing.swing_type === 'high' && candle.close > candle.open) {
        obs.push({
          symbol,
          timestamp: candle.time,
          high: candle.high,
          low: candle.low,
          ob_type: 'bearish'
        });
        break;
      } else if (swing.swing_type === 'low' && candle.close < candle.open) {
        obs.push({
          symbol,
          timestamp: candle.time,
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

function detectBOS_CHoCH(symbol, df, swings) {
  const signals = [];
  const sortedSwings = [...swings].sort((a, b) => a.timestamp - b.timestamp);

  for (let i = 0; i < sortedSwings.length - 1; i++) {
    const currentSwing = sortedSwings[i];
    const idx = df.findIndex(c => c.time === currentSwing.timestamp);
    if (idx < 0) continue;

    for (let j = idx + 1; j < df.length; j++) {
      const price = df[j];
      if (currentSwing.swing_type === 'high' && price.high > currentSwing.price) {
        signals.push({
          symbol,
          timestamp: price.time,
          signal_type: 'BOS',
          direction: 'bullish',
          price_level: currentSwing.price
        });
        break;
      } else if (currentSwing.swing_type === 'low' && price.low < currentSwing.price) {
        signals.push({
          symbol,
          timestamp: price.time,
          signal_type: 'BOS',
          direction: 'bearish',
          price_level: currentSwing.price
        });
        break;
      }
    }
  }
  return signals;
}

// ------------------------------------------------------------
// Main Handler with pagination (offset & limit)
// ------------------------------------------------------------
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Get secret from env or hardcode
  const secret = req.query.secret;
  const expectedSecret = process.env.ADMIN_SECRET_KEY;
  if (!expectedSecret || !secret || secret !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing ADMIN_SECRET_KEY' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'Supabase credentials missing' });
  }
  const supabase = createClient(supabaseUrl, supabaseKey);

  // Parse pagination parameters
  const offset = parseInt(req.query.offset) || 0;
  const limit = Math.min(parseInt(req.query.limit) || 10, 50); // max 50 per batch

  try {
    // 1. Get all distinct symbols (paginated to avoid huge list)
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
    for (const symbol of symbolsToProcess) {
      try {
        // Fetch all data for this symbol (pagination inside)
        let allData = [];
        let from = 0;
        const pageSize = 1000;
        let hasMore = true;
        while (hasMore) {
          const { data, error } = await supabase
            .from('prices')
            .select('time, open, high, low, close, volume')
            .eq('symbol', symbol)
            .order('time', { ascending: true })
            .range(from, from + pageSize - 1);
          if (error) throw error;
          if (!data || data.length === 0) break;
          allData.push(...data);
          if (data.length < pageSize) hasMore = false;
          from += pageSize;
        }

        if (allData.length < 10) {
          results.push({ symbol, status: 'skipped', reason: 'insufficient data' });
          continue;
        }

        const df = allData.map(d => ({
          time: new Date(d.time),
          open: parseFloat(d.open),
          high: parseFloat(d.high),
          low: parseFloat(d.low),
          close: parseFloat(d.close),
          volume: parseInt(d.volume, 10)
        }));

        // Detect SMC indicators
        const swings = detectSwings(symbol, df);
        const fvgs = detectFVG(symbol, df);
        const obs = detectOrderBlocks(symbol, df, swings);
        const bos = detectBOS_CHoCH(symbol, df, swings);

        // Upsert with conflict handling
        if (swings.length) {
          await supabase.from('smc_swings').upsert(swings, { onConflict: 'symbol, timestamp, swing_type' });
        }
        if (fvgs.length) {
          await supabase.from('smc_fvg').upsert(fvgs, { onConflict: 'symbol, start_time' });
        }
        if (obs.length) {
          await supabase.from('smc_order_blocks').upsert(obs, { onConflict: 'symbol, timestamp' });
        }
        if (bos.length) {
          await supabase.from('smc_bos_choch').upsert(bos, { onConflict: 'symbol, timestamp, signal_type' });
        }

        results.push({
          symbol,
          status: 'success',
          counts: { swings: swings.length, fvgs: fvgs.length, obs: obs.length, bos: bos.length }
        });
      } catch (err) {
        console.error(`Error processing ${symbol}:`, err);
        results.push({ symbol, status: 'failed', error: err.message });
      }
    }

    const nextOffset = offset + symbolsToProcess.length;
    return res.status(200).json({
      message: 'Batch processed',
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