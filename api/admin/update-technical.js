import { createClient } from '@supabase/supabase-js';

// ------------------------------------------------------------
// Technical indicator functions (self-contained)
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

// ------------------------------------------------------------
// Accumulation / Distribution Line
// ------------------------------------------------------------
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

// ------------------------------------------------------------
// Anchored VWAP (HLC3) – anchored at first date
// ------------------------------------------------------------
function AnchoredVWAP(high, low, close, volume) {
    const vwap = new Array(close.length).fill(null);
    let cumPV = 0, cumVol = 0;
    for (let i = 0; i < close.length; i++) {
        const typicalPrice = (high[i] + low[i] + close[i]) / 3;
        cumPV += typicalPrice * volume[i];
        cumVol += volume[i];
        vwap[i] = cumVol > 0 ? cumPV / cumVol : null;
    }
    return vwap;
}

function detectCrossover(fastMA, slowMA) {
    if (fastMA.length < 2 || slowMA.length < 2) return { status: null, signal: null, fast: null, slow: null };
    const lastIdx = fastMA.length - 1;
    const fastNow = fastMA[lastIdx];
    const slowNow = slowMA[lastIdx];
    if (fastNow === null || slowNow === null) return { status: null, signal: null, fast: fastNow, slow: slowNow };
    const fastPrev = fastMA[lastIdx - 1];
    const slowPrev = slowMA[lastIdx - 1];
    let status = 'neutral';
    if (fastNow > slowNow) status = 'bullish';
    else if (fastNow < slowNow) status = 'bearish';
    let signal = 'none';
    if (fastPrev !== null && slowPrev !== null) {
        if (fastPrev <= slowPrev && fastNow > slowNow) signal = 'golden_cross';
        else if (fastPrev >= slowPrev && fastNow < slowNow) signal = 'death_cross';
    }
    return { status, signal, fast: fastNow, slow: slowNow };
}

// Helper for average volume (20 days) from the whole array (takes last 20)
function getAverageVolume(volumes) {
    if (!volumes.length) return null;
    const last20 = volumes.slice(-20);
    const sum = last20.reduce((a, b) => a + b, 0);
    return Math.round(sum / last20.length);
}

// ------------------------------------------------------------
// Process a single symbol – fetches ALL data (no 500-day limit)
// ------------------------------------------------------------
async function processSymbolFull(supabase, symbol) {
    try {
        // Fetch all data for this symbol using pagination
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
            if (data.length < pageSize) hasMore = false;
            from += pageSize;
        }

        if (!allData || allData.length < 2) {
            throw new Error(`Insufficient data (${allData?.length || 0} rows)`);
        }

        const close = allData.map(d => parseFloat(d.close));
        const high = allData.map(d => parseFloat(d.high));
        const low = allData.map(d => parseFloat(d.low));
        const vol = allData.map(d => parseInt(d.volume, 10));

        // Compute indicators on the full history
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
        const obv = OBV(close, vol);
        const adLine = AccumulationDistribution(high, low, close, vol);
        const anchoredVwap = AnchoredVWAP(high, low, close, vol);

        // Crossovers (using full arrays)
        const golden = detectCrossover(sma50, sma200);
        const short = detectCrossover(ema9, ema21);
        const swing = detectCrossover(ema20, ema50);
        const medium = detectCrossover(ema50, ema100);

        const last = close.length - 1;
        const lastDate = allData[last].date;
        const avgVolume20d = getAverageVolume(vol);
        const latestVolume = vol[vol.length - 1];

        return {
            symbol,
            latest_traded_date: lastDate,
            rsi_14: rsi[last] ? parseFloat(rsi[last].toFixed(2)) : null,
            macd_line: macd[last] ? parseFloat(macd[last].toFixed(4)) : null,
            macd_signal: signal[last] ? parseFloat(signal[last].toFixed(4)) : null,
            macd_histogram: histogram[last] ? parseFloat(histogram[last].toFixed(4)) : null,
            atr_14: atr[last] ? parseFloat(atr[last].toFixed(2)) : null,
            obv: obv[last] ? Math.round(obv[last]) : null,
            ad_line: adLine[last] ? parseFloat(adLine[last].toFixed(2)) : null,
            anchored_vwap: anchoredVwap[last] ? parseFloat(anchoredVwap[last].toFixed(2)) : null,
            latest_close: parseFloat(close[last].toFixed(2)),
            avg_volume_20d: avgVolume20d,
            latest_volume: latestVolume,
            golden_cross_fast: golden.fast ? parseFloat(golden.fast.toFixed(2)) : null,
            golden_cross_slow: golden.slow ? parseFloat(golden.slow.toFixed(2)) : null,
            golden_cross_status: golden.status,
            golden_cross_signal: golden.signal,
            short_cross_fast: short.fast ? parseFloat(short.fast.toFixed(2)) : null,
            short_cross_slow: short.slow ? parseFloat(short.slow.toFixed(2)) : null,
            short_cross_status: short.status,
            short_cross_signal: short.signal,
            swing_cross_fast: swing.fast ? parseFloat(swing.fast.toFixed(2)) : null,
            swing_cross_slow: swing.slow ? parseFloat(swing.slow.toFixed(2)) : null,
            swing_cross_status: swing.status,
            swing_cross_signal: swing.signal,
            medium_cross_fast: medium.fast ? parseFloat(medium.fast.toFixed(2)) : null,
            medium_cross_slow: medium.slow ? parseFloat(medium.slow.toFixed(2)) : null,
            medium_cross_status: medium.status,
            medium_cross_signal: medium.signal,
        };
    } catch (err) {
        throw err;
    }
}

// ------------------------------------------------------------
// SMC Helper: convert Date to ISO string
// ------------------------------------------------------------
function toISO(date) {
    return date instanceof Date ? date.toISOString() : date;
}

// ------------------------------------------------------------
// Detect Swing Highs and Lows
// ------------------------------------------------------------
function detectSwings(symbol, df, windowSize = 5) {
    const swings = [];
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
    if (!df.length || !swings.length) return obs;
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
                    ob_type: 'bearish',
                    is_mitigated: false
                });
                break;
            } else if (swing.swing_type === 'low' && candle.close < candle.open) {
                obs.push({
                    symbol,
                    timestamp: toISO(candle.time),
                    high: candle.high,
                    low: candle.low,
                    ob_type: 'bullish',
                    is_mitigated: false
                });
                break;
            }
        }
    }
    return obs;
}

// ------------------------------------------------------------
// Detect Fair Value Gaps (FVG)
// Schema: symbol, start_time, end_time, high, low, fvg_type, is_mitigated
// ------------------------------------------------------------
function detectFVG(symbol, df) {
    const fvgs = [];
    if (df.length < 3) return fvgs;

    for (let i = 2; i < df.length; i++) {
        const c0 = df[i - 2];
        const c1 = df[i - 1];
        const c2 = df[i];

        // Bullish FVG: Current candle's low > Candle-2's high
        if (c2.low > c0.high) {
            fvgs.push({
                symbol,
                start_time: toISO(c0.time),
                end_time: toISO(c2.time),
                high: c2.low,
                low: c0.high,
                fvg_type: 'bullish',
                is_mitigated: false
            });
        }
        // Bearish FVG: Current candle's high < Candle-2's low
        else if (c2.high < c0.low) {
            fvgs.push({
                symbol,
                start_time: toISO(c0.time),
                end_time: toISO(c2.time),
                high: c0.low,
                low: c2.high,
                fvg_type: 'bearish',
                is_mitigated: false
            });
        }
    }
    return fvgs;
}

// ------------------------------------------------------------
// Detect Break of Structure (BOS) & Change of Character (CHoCH)
// Schema: symbol, timestamp, signal_type, direction, price_level
// ------------------------------------------------------------
function detectBOSandCHoCH(symbol, df, swings) {
    const structures = [];
    if (df.length < 5 || swings.length < 2) return structures;

    let lastSwingHigh = null;
    let lastSwingLow = null;
    let lastBreakType = null; // 'bullish' | 'bearish'

    for (let i = 0; i < df.length; i++) {
        const candle = df[i];
        const candleTime = toISO(candle.time);

        // Update active swing levels up to current candle
        const activeSwings = swings.filter(s => new Date(s.timestamp) <= new Date(candleTime));
        const recentHighs = activeSwings.filter(s => s.swing_type === 'high');
        const recentLows = activeSwings.filter(s => s.swing_type === 'low');

        if (recentHighs.length) lastSwingHigh = recentHighs[recentHighs.length - 1];
        if (recentLows.length) lastSwingLow = recentLows[recentLows.length - 1];

        if (lastSwingHigh && candle.close > lastSwingHigh.price) {
            const isChoch = lastBreakType === 'bearish';
            structures.push({
                symbol,
                timestamp: candleTime,
                signal_type: isChoch ? 'CHoCH' : 'BOS',
                direction: 'bullish',
                price_level: candle.close
            });
            lastBreakType = 'bullish';
            lastSwingHigh = null; // consumed
        } else if (lastSwingLow && candle.close < lastSwingLow.price) {
            const isChoch = lastBreakType === 'bullish';
            structures.push({
                symbol,
                timestamp: candleTime,
                signal_type: isChoch ? 'CHoCH' : 'BOS',
                direction: 'bearish',
                price_level: candle.close
            });
            lastBreakType = 'bearish';
            lastSwingLow = null; // consumed
        }
    }
    return structures;
}

// ------------------------------------------------------------
// Robust Insert Helper: Deletes existing symbol data to prevent
// unique constraint violations, then batch inserts new rows.
// ------------------------------------------------------------
async function safeInsertSymbolData(supabase, tableName, symbol, rows) {
    if (!rows || rows.length === 0) return { count: 0, status: 'skipped (no rows)' };

    // 1. Clear old data for this symbol
    const { error: delError } = await supabase
        .from(tableName)
        .delete()
        .eq('symbol', symbol);

    if (delError) {
        console.warn(`[SMC Delete] ${tableName} for ${symbol}: ${delError.message}`);
    }

    // 2. Insert new data in chunks of 200
    const chunkSize = 200;
    let inserted = 0;

    for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        const { error } = await supabase.from(tableName).insert(chunk);

        if (error) {
            return {
                count: inserted,
                total: rows.length,
                status: 'failed',
                error: error.message
            };
        }
        inserted += chunk.length;
    }

    return { count: inserted, status: 'success' };
}

// ------------------------------------------------------------
// Process SMC for a single symbol
// ------------------------------------------------------------
async function processSMCForSymbol(supabase, symbol) {
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
        if (data.length < pageSize) hasMore = false;
        from += pageSize;
    }

    if (!allData || allData.length < 10) {
        throw new Error(`Insufficient data for SMC (${allData?.length || 0} rows)`);
    }

    const df = allData.map(d => ({
        time: new Date(d.date),
        open: parseFloat(d.open),
        high: parseFloat(d.high),
        low: parseFloat(d.low),
        close: parseFloat(d.close),
        volume: parseInt(d.volume, 10) || 0
    }));

    const swings = detectSwings(symbol, df);
    const obs = detectOrderBlocks(symbol, df, swings);
    const fvgs = detectFVG(symbol, df);
    const bosChoch = detectBOSandCHoCH(symbol, df, swings);

    // Insert into Supabase tables with clean symbol-level replacements
    const swingsWrite = await safeInsertSymbolData(supabase, 'smc_swings', symbol, swings);
    const obsWrite = await safeInsertSymbolData(supabase, 'smc_order_blocks', symbol, obs);
    const fvgsWrite = await safeInsertSymbolData(supabase, 'smc_fvg', symbol, fvgs);
    const bosChochWrite = await safeInsertSymbolData(supabase, 'smc_bos_choch', symbol, bosChoch);

    return {
        rows_analyzed: allData.length,
        swings: swingsWrite,
        order_blocks: obsWrite,
        fvg: fvgsWrite,
        bos_choch: bosChochWrite
    };
}

// ------------------------------------------------------------
// Main handler – supports route (technical | update-smc), symbol, offset and limit
// ------------------------------------------------------------
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    // Authentication: Require ADMIN_SECRET_KEY environment variable
    const secret = req.query.secret;
    const expectedSecret = process.env.ADMIN_SECRET_KEY;
    if (!expectedSecret || !secret || secret !== expectedSecret) {
        return res.status(401).json({ error: 'Unauthorized: Invalid or missing ADMIN_SECRET_KEY' });
    }

    const route = (req.query.route || 'technical').toLowerCase();
    const symbolParam = req.query.symbol || req.query.symbols;

    const offset = parseInt(req.query.offset) || 0;
    const limit = Math.min(parseInt(req.query.limit) || 10, 50); // max 50 per batch

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseKey) {
        console.error('Missing Supabase credentials');
        return res.status(500).json({ error: 'Supabase credentials missing' });
    }
    const supabase = createClient(supabaseUrl, supabaseKey);

    try {
        let symbolsToProcess = [];
        let totalSymbols = 0;
        let nextOffset = null;

        if (symbolParam) {
            if (Array.isArray(symbolParam)) {
                symbolsToProcess = symbolParam
                    .flatMap(s => typeof s === 'string' ? s.split(',') : [])
                    .map(s => s.trim().toUpperCase())
                    .filter(Boolean);
            } else if (typeof symbolParam === 'string') {
                symbolsToProcess = symbolParam
                    .split(',')
                    .map(s => s.trim().toUpperCase())
                    .filter(Boolean);
            }
            totalSymbols = symbolsToProcess.length;
        } else {
            // 1. Get the full list of distinct symbols (sorted)
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
            totalSymbols = uniqueSymbols.length;

            // 2. Slice the batch
            symbolsToProcess = uniqueSymbols.slice(offset, offset + limit);
            if (symbolsToProcess.length === 0) {
                return res.status(200).json({
                    route,
                    message: 'No more symbols to process',
                    total_symbols: totalSymbols,
                    processed: 0,
                    next_offset: offset,
                });
            }
            nextOffset = offset + symbolsToProcess.length;
        }

        const isSMC = route === 'update-smc' || route === 'smc';

        // 3. Process symbols sequentially (to avoid timeouts)
        const results = [];
        for (const sym of symbolsToProcess) {
            try {
                if (isSMC) {
                    const smcResult = await processSMCForSymbol(supabase, sym);
                    results.push({ symbol: sym, status: 'success', details: smcResult });
                } else {
                    const indicators = await processSymbolFull(supabase, sym);
                    const { error: upsertError } = await supabase
                        .from('technical_indicators')
                        .upsert(indicators, { onConflict: 'symbol' });
                    if (upsertError) throw upsertError;
                    results.push({ symbol: sym, status: 'success' });
                }
            } catch (err) {
                results.push({ symbol: sym, status: 'failed', error: err.message });
            }
            console.log(`[${route}] Processed ${sym} (${results.length}/${symbolsToProcess.length})`);
        }

        return res.status(200).json({
            route: isSMC ? 'update-smc' : 'technical',
            message: `${isSMC ? 'SMC' : 'Technical indicators'} batch processed`,
            total_symbols: totalSymbols,
            processed_symbols: symbolsToProcess.length,
            next_offset: nextOffset,
            results,
        });
    } catch (err) {
        console.error('Update error:', err);
        return res.status(500).json({ error: 'Internal server error', details: err.message });
    }
}