import { createClient } from '@supabase/supabase-js';

// ------------------------------------------------------------
// SMC Detection Functions (ported from Python logic)
// ------------------------------------------------------------

/**
 * Detect Swing Highs and Lows using a rolling window.
 * Returns an array of swing objects: { symbol, timestamp, price, swing_type }
 */
function detectSwings(symbol, df) {
  const swings = [];
  const windowSize = 5; // number of candles on each side to compare

  for (let i = windowSize; i < df.length - windowSize; i++) {
    const current = df[i];
    const left = df.slice(i - windowSize, i);
    const right = df.slice(i + 1, i + windowSize + 1);

    // Swing High: current high > all highs in the window
    const leftHighs = left.map(c => c.high);
    const rightHighs = right.map(c => c.high);
    if (current.high > Math.max(...leftHighs) && current.high > Math.max(...rightHighs)) {
      swings.push({
        symbol,
        timestamp: current.time,
        price: current.high,
        swing_type: 'high'
      });
    }

    // Swing Low: current low < all lows in the window
    const leftLows = left.map(c => c.low);
    const rightLows = right.map(c => c.low);
    if (current.low < Math.min(...leftLows) && current.low < Math.min(...rightLows)) {
      swings.push({
        symbol,
        timestamp: current.time,
        price: current.low,
        swing_type: 'low'
      });
    }
  }
  return swings;
}

/**
 * Detect Fair Value Gaps (FVG) using 3‑candle rule.
 * Returns array of FVG objects.
 */
function detectFVG(symbol, df) {
  const fvgs = [];
  const lookback = 3; // compare candle i with candle i-lookback

  for (let i = lookback; i < df.length; i++) {
    const current = df[i];
    const previous = df[i - lookback];
    // Bullish FVG: current low > previous high
    if (current.low > previous.high) {
      fvgs.push({
        symbol,
        start_time: previous.time,
        end_time: current.time,
        high: current.low,   // upper boundary of the gap
        low: previous.high,  // lower boundary
        fvg_type: 'bullish'
      });
    }
    // Bearish FVG: current high < previous low
    else if (current.high < previous.low) {
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

/**
 * Detect Order Blocks (simplified version).
 * For each swing high/low, find the strongest opposite candle before it.
 * Returns array of Order Block objects.
 */
function detectOrderBlocks(symbol, df, swings) {
  const obs = [];
  const avgRange = df.reduce((sum, c) => sum + (c.high - c.low), 0) / df.length;

  // For each swing, look back a few candles for a strong opposite move
  for (const swing of swings) {
    const swingIdx = df.findIndex(c => c.time === swing.timestamp);
    if (swingIdx < 0) continue;

    // Look back up to 10 candles before the swing
    const start = Math.max(0, swingIdx - 10);
    for (let i = swingIdx - 1; i >= start; i--) {
      const candle = df[i];
      const range = candle.high - candle.low;
      if (range < 1.5 * avgRange) continue; // not strong enough

      // If swing is high, look for a strong bullish candle (close > open) before it
      if (swing.swing_type === 'high' && candle.close > candle.open) {
        obs.push({
          symbol,
          timestamp: candle.time,
          high: candle.high,
          low: candle.low,
          ob_type: 'bearish' // strong bullish candle before a swing high => bearish OB
        });
        break;
      }
      // If swing is low, look for a strong bearish candle before it
      else if (swing.swing_type === 'low' && candle.close < candle.open) {
        obs.push({
          symbol,
          timestamp: candle.time,
          high: candle.high,
          low: candle.low,
          ob_type: 'bullish' // strong bearish candle before a swing low => bullish OB
        });
        break;
      }
    }
  }
  return obs;
}

/**
 * Detect Break of Structure (BOS) and Change of Character (CHoCH).
 * For each swing, check if price later breaks it.
 * Returns array of BOS/CHoCH objects.
 */
function detectBOS_CHoCH(symbol, df, swings) {
  const signals = [];
  // Sort swings by time
  const sortedSwings = [...swings].sort((a, b) => a.timestamp - b.timestamp);

  for (let i = 0; i < sortedSwings.length - 1; i++) {
    const currentSwing = sortedSwings[i];
    const nextSwing = sortedSwings[i + 1];
    // Find the index of the current swing in df
    const idx = df.findIndex(c => c.time === currentSwing.timestamp);
    if (idx < 0) continue;

    // Look ahead from the next candle after the swing
    for (let j = idx + 1; j < df.length; j++) {
      const price = df[j];
      // If swing is high and price breaks above it → bullish BOS
      if (currentSwing.swing_type === 'high' && price.high > currentSwing.price) {
        signals.push({
          symbol,
          timestamp: price.time,
          signal_type: 'BOS',
          direction: 'bullish',
          price_level: currentSwing.price
        });
        break; // stop after first break
      }
      // If swing is low and price breaks below it → bearish BOS
      else if (currentSwing.swing_type === 'low' && price.low < currentSwing.price) {
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

  // CHoCH: when price breaks the most recent swing high in an uptrend or swing low in a downtrend.
  // This is a simplified version – we'll just mark the first break after a swing.
  // You can enhance with trend detection.
  return signals;
}

// ------------------------------------------------------------
// Main Handler
// ------------------------------------------------------------
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Authentication
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

  try {
    // 1. Get list of all distinct symbols (paginated)
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
    const uniqueSymbols = [...new Set(allRows.map(r => r.symbol))];
    console.log(`Found ${uniqueSymbols.length} symbols for SMC processing`);

    // 2. Process each symbol (in batches to avoid timeout)
    const results = [];
    for (const symbol of uniqueSymbols) {
      try {
        // Fetch all OHLCV data for this symbol (oldest to newest)
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
          console.log(`Skipping ${symbol} – insufficient data`);
          results.push({ symbol, status: 'skipped', reason: 'insufficient data' });
          continue;
        }

        // Convert to array of objects with numeric fields
        const df = allData.map(d => ({
          time: new Date(d.time),
          open: parseFloat(d.open),
          high: parseFloat(d.high),
          low: parseFloat(d.low),
          close: parseFloat(d.close),
          volume: parseInt(d.volume, 10)
        }));

        // ----- Detect SMC indicators -----
        const swings = detectSwings(symbol, df);
        const fvgs = detectFVG(symbol, df);
        const obs = detectOrderBlocks(symbol, df, swings);
        const bos = detectBOS_CHoCH(symbol, df, swings);

        // 3. Upsert all into Supabase (using conflict handling)
        const upsertOptions = { onConflict: 'symbol, timestamp, swing_type' };
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

        console.log(`Processed ${symbol}: swings=${swings.length}, fvgs=${fvgs.length}, obs=${obs.length}, bos=${bos.length}`);
        results.push({ symbol, status: 'success', counts: { swings: swings.length, fvgs: fvgs.length, obs: obs.length, bos: bos.length } });
      } catch (err) {
        console.error(`Error processing ${symbol}:`, err);
        results.push({ symbol, status: 'failed', error: err.message });
      }
    }

    return res.status(200).json({
      message: 'SMC update completed',
      total_symbols: uniqueSymbols.length,
      results,
    });
  } catch (err) {
    console.error('SMC update error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
}