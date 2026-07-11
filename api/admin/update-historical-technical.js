import { createClient } from '@supabase/supabase-js';

// ------------------------------------------------------------
// Technical indicator functions (same as before)
// ------------------------------------------------------------
function SMA(values, period) {
  const result = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period - 1) {
      result[i] = sum / period;
      sum -= values[i - (period - 1)];
    }
  }
  return result;
}

function EMA(values, period) {
  const result = new Array(values.length).fill(null);
  const multiplier = 2 / (period + 1);
  let ema = values[0];
  result[0] = ema;
  for (let i = 1; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
    result[i] = ema;
  }
  return result;
}

function RSI(values, period = 14) {
  const result = new Array(values.length).fill(null);
  if (values.length < period + 1) return result;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  let rs = avgGain / avgLoss;
  result[period] = 100 - (100 / (1 + rs));
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) {
      avgGain = (avgGain * (period - 1) + diff) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) - diff) / period;
    }
    rs = avgGain / avgLoss;
    result[i] = 100 - (100 / (1 + rs));
  }
  return result;
}

function MACD(prices, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = EMA(prices, fast);
  const emaSlow = EMA(prices, slow);
  const macdLine = emaFast.map((v, i) => (v !== null && emaSlow[i] !== null) ? v - emaSlow[i] : null);
  const signalLine = EMA(macdLine.filter(v => v !== null), signalPeriod);
  const alignedSignal = new Array(prices.length).fill(null);
  let idx = 0;
  for (let i = 0; i < macdLine.length; i++) {
    if (macdLine[i] !== null && idx < signalLine.length) {
      alignedSignal[i] = signalLine[idx];
      idx++;
    }
  }
  const histogram = macdLine.map((v, i) => (v !== null && alignedSignal[i] !== null) ? v - alignedSignal[i] : null);
  return { macd: macdLine, signal: alignedSignal, histogram };
}

function ATR(high, low, close, period = 14) {
  const tr = new Array(high.length).fill(null);
  if (high.length === 0) return tr;
  tr[0] = high[0] - low[0];
  for (let i = 1; i < high.length; i++) {
    const hl = high[i] - low[i];
    const hc = Math.abs(high[i] - close[i - 1]);
    const lc = Math.abs(low[i] - close[i - 1]);
    tr[i] = Math.max(hl, hc, lc);
  }
  const atr = new Array(high.length).fill(null);
  if (high.length < period) return atr;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  atr[period - 1] = sum / period;
  for (let i = period; i < tr.length; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }
  return atr;
}

function OBV(close, volume) {
  const obv = new Array(close.length).fill(0);
  if (close.length === 0) return obv;
  obv[0] = volume[0];
  for (let i = 1; i < close.length; i++) {
    if (close[i] > close[i - 1]) obv[i] = obv[i - 1] + volume[i];
    else if (close[i] < close[i - 1]) obv[i] = obv[i - 1] - volume[i];
    else obv[i] = obv[i - 1];
  }
  return obv;
}

function getAverageVolume(volumes, currentIndex, days = 20) {
  const start = Math.max(0, currentIndex - days + 1);
  const slice = volumes.slice(start, currentIndex + 1);
  if (slice.length === 0) return null;
  const sum = slice.reduce((a, b) => a + b, 0);
  return Math.round(sum / slice.length);
}

// Accumulation/Distribution Line
function AccumulationDistribution(high, low, close, volume) {
  const ad = new Array(close.length).fill(0);
  let prevAD = 0;
  for (let i = 0; i < close.length; i++) {
    const range = high[i] - low[i];
    if (range === 0) {
      ad[i] = prevAD;
      continue;
    }
    const multiplier = ((close[i] - low[i]) - (high[i] - close[i])) / range;
    const moneyFlow = multiplier * volume[i];
    prevAD += moneyFlow;
    ad[i] = prevAD;
  }
  return ad;
}

// Anchored VWAP (anchored at the very first date for this symbol)
function AnchoredVWAP(close, volume) {
  const vwap = new Array(close.length).fill(null);
  let cumPV = 0, cumVol = 0;
  for (let i = 0; i < close.length; i++) {
    cumPV += close[i] * volume[i];
    cumVol += volume[i];
    vwap[i] = cumVol > 0 ? cumPV / cumVol : null;
  }
  return vwap;
}

// ------------------------------------------------------------
// Process a single symbol's entire history
// ------------------------------------------------------------
async function processSymbolHistory(supabase, symbol) {
  try {
    // Fetch ALL data for this symbol using pagination
    let allData = [];
    let from = 0;
    const pageSize = 1000;
    let hasMore = true;

    while (hasMore) {
      const { data, error } = await supabase
        .from('prices')
        .select('date, open, high, low, close, volume')
        .eq('symbol', symbol)
        .order('date', { ascending: true })
        .range(from, from + pageSize - 1);

      if (error) throw error;
      if (!data || data.length === 0) break;

      allData.push(...data);

      if (data.length < pageSize) {
        hasMore = false;
      } else {
        from += pageSize;
      }
    }

    if (!allData || allData.length < 50) {
      throw new Error(`Insufficient data (${allData?.length || 0} rows)`);
    }

    const dates = allData.map(d => d.date);
    const close = allData.map(d => parseFloat(d.close));
    const high = allData.map(d => parseFloat(d.high));
    const low = allData.map(d => parseFloat(d.low));
    const volume = allData.map(d => parseInt(d.volume, 10));

    console.log(`Processing ${symbol}: ${dates.length} records`);

    // Calculate all indicators for every date
    const sma50 = SMA(close, 50);
    const sma200 = SMA(close, 200);
    const ema9 = EMA(close, 9);
    const ema21 = EMA(close, 21);
    const ema20 = EMA(close, 20);
    const ema50 = EMA(close, 50);
    const ema100 = EMA(close, 100);
    const rsi = RSI(close, 14);
    const { macd, signal, histogram } = MACD(close);
    const atr = ATR(high, low, close, 14);
    const obv = OBV(close, volume);
    const adLine = AccumulationDistribution(high, low, close, volume);
    const anchoredVwap = AnchoredVWAP(close, volume);

    // Build array of records to insert
    const records = [];
    for (let i = 0; i < dates.length; i++) {
      const avgVolume20d = getAverageVolume(volume, i, 20);

      records.push({
        symbol,
        date: dates[i],
        sma_50: sma50[i] ? parseFloat(sma50[i].toFixed(2)) : null,
        sma_200: sma200[i] ? parseFloat(sma200[i].toFixed(2)) : null,
        ema_9: ema9[i] ? parseFloat(ema9[i].toFixed(2)) : null,
        ema_21: ema21[i] ? parseFloat(ema21[i].toFixed(2)) : null,
        ema_20: ema20[i] ? parseFloat(ema20[i].toFixed(2)) : null,
        ema_50: ema50[i] ? parseFloat(ema50[i].toFixed(2)) : null,
        ema_100: ema100[i] ? parseFloat(ema100[i].toFixed(2)) : null,
        rsi_14: rsi[i] ? parseFloat(rsi[i].toFixed(2)) : null,
        macd_line: macd[i] ? parseFloat(macd[i].toFixed(4)) : null,
        macd_signal: signal[i] ? parseFloat(signal[i].toFixed(4)) : null,
        macd_histogram: histogram[i] ? parseFloat(histogram[i].toFixed(4)) : null,
        atr_14: atr[i] ? parseFloat(atr[i].toFixed(2)) : null,
        obv: obv[i] ? Math.round(obv[i]) : null,
        avg_volume_20d: avgVolume20d,
        volume: volume[i],
        close: parseFloat(close[i].toFixed(2)),
        ad_line: adLine[i] ? parseFloat(adLine[i].toFixed(2)) : null,
        anchored_vwap: anchoredVwap[i] ? parseFloat(anchoredVwap[i].toFixed(2)) : null,
      });
    }

    // Upsert records in batches (to avoid payload size limits)
    const batchSize = 500;
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      const { error: upsertError } = await supabase
        .from('historical_technical_indicators')
        .upsert(batch, { onConflict: 'symbol,date' });
      if (upsertError) throw upsertError;
    }

    return { symbol, status: 'success', records_count: records.length };
  } catch (err) {
    return { symbol, status: 'failed', error: err.message };
  }
}

// ------------------------------------------------------------
// Main handler (now supports pagination via offset & limit)
// ------------------------------------------------------------
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Authentication
  const secret = req.query.secret;
  if (secret !== 'test123') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'Supabase credentials missing' });
  }
  const supabase = createClient(supabaseUrl, supabaseKey);

  // ----- Pagination parameters -----
  const offset = parseInt(req.query.offset) || 0;
  const limit = parseInt(req.query.limit) || 5;   // process 5 symbols per request (adjust as needed)
  const specificSymbol = req.query.symbol;

  try {
    // 1. Get list of all distinct symbols (sorted)
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

    // If a specific symbol is given, process only that one
    let symbolsToProcess = [];
    if (specificSymbol) {
      if (!uniqueSymbols.includes(specificSymbol.toUpperCase())) {
        return res.status(404).json({ error: `Symbol ${specificSymbol} not found` });
      }
      symbolsToProcess = [specificSymbol.toUpperCase()];
    } else {
      // Slice based on offset and limit
      symbolsToProcess = uniqueSymbols.slice(offset, offset + limit);
    }

    if (symbolsToProcess.length === 0) {
      return res.status(200).json({
        message: 'No more symbols to process',
        total_symbols: totalSymbols,
        processed: 0,
        next_offset: offset,
      });
    }

    // 2. Process the selected symbols
    const results = [];
    const concurrency = 1; // process one at a time to avoid timeouts
    const queue = [...symbolsToProcess];

    async function worker() {
      while (queue.length) {
        const sym = queue.shift();
        const result = await processSymbolHistory(supabase, sym);
        results.push(result);
        console.log(`Completed: ${sym} (${results.length}/${symbolsToProcess.length})`);
      }
    }

    const workers = Array(concurrency).fill().map(() => worker());
    await Promise.all(workers);

    // 3. Compute next offset for the next batch
    const nextOffset = specificSymbol ? null : offset + symbolsToProcess.length;

    return res.status(200).json({
      message: 'Batch processed',
      total_symbols: totalSymbols,
      processed_symbols: symbolsToProcess.length,
      next_offset: nextOffset,
      results,
    });
  } catch (err) {
    console.error('Historical update error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
}
