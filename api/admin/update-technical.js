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
// Anchored VWAP (anchored at the first date of the symbol)
// ------------------------------------------------------------
function AnchoredVWAP(high, low, close, volume) {
    const vwap = new Array(close.length).fill(null);
    let cumPV = 0, cumVol = 0;
    for (let i = 0; i < close.length; i++) {
        const typicalPrice = (high[i] + low[i] + close[i]) / 3;  // ✅ HLC3
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

// Helper for average volume (20 days)
function getAverageVolume(volumes) {
    if (!volumes.length) return null;
    const last20 = volumes.slice(-20);
    const sum = last20.reduce((a, b) => a + b, 0);
    return Math.round(sum / last20.length);
}

// ------------------------------------------------------------
// Process a single symbol
// ------------------------------------------------------------
async function processSymbol(supabase, symbol, limit = 500) {
    try {
        const { data, error } = await supabase
            .from('prices')
            .select('date, open, high, low, close, volume')
            .eq('symbol', symbol)
            .order('date', { ascending: false })
            .limit(limit);
        if (error) throw error;
        if (!data || data.length < 2) throw new Error(`Insufficient data (${data?.length || 0} rows)`);
        data.reverse();

        const close = data.map(d => parseFloat(d.close));
        const high = data.map(d => parseFloat(d.high));
        const low = data.map(d => parseFloat(d.low));
        const vol = data.map(d => parseInt(d.volume, 10));

        // Volume stats
        const avgVolume20d = getAverageVolume(vol);
        const latestVolume = vol[vol.length - 1];

        const sma50 = SMA(close, 50);
        const sma200 = SMA(close, 200);
        const ema9 = EMA(close, 9);
        const ema21 = EMA(close, 21);
        const ema20 = EMA(close, 20);
        const ema50 = EMA(close, 50);
        const ema100 = EMA(close, 100);

        const golden = detectCrossover(sma50, sma200);
        const short = detectCrossover(ema9, ema21);
        const swing = detectCrossover(ema20, ema50);
        const medium = detectCrossover(ema50, ema100);

        const rsi = RSI(close, 14);
        const { macd, signal, histogram } = MACD(close);
        const atr = ATR(high, low, close, 14);
        const obv = OBV(close, vol);

        const adLine = AccumulationDistribution(high, low, close, vol);
        const anchoredVwap = AnchoredVWAP(high, low, close, volume);

        const last = close.length - 1;
        const lastDate = data[last].date;

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
// Main handler
// ------------------------------------------------------------
export default async function handler(req, res) {
    // CORS (optional)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    // ----- Authentication (temporary simple secret) -----
    const secret = req.query.secret;
    // Change this to your own secret (alphanumeric only, no special chars)
    if (secret !== 'test123') {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // Use service role key for write
    if (!supabaseUrl || !supabaseKey) {
        console.error('Missing Supabase credentials');
        return res.status(500).json({ error: 'Supabase credentials missing' });
    }
    const supabase = createClient(supabaseUrl, supabaseKey);

    try {
        // Get all distinct symbols (paginated)
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
        console.log(`Found ${uniqueSymbols.length} symbols`);

        // Process with concurrency 3 to avoid timeout / rate limits
        const results = [];
        const concurrency = 3;
        const queue = [...uniqueSymbols];
        async function worker() {
            while (queue.length) {
                const sym = queue.shift();
                try {
                    const indicators = await processSymbol(supabase, sym);
                    const { error: upsertError } = await supabase
                        .from('technical_indicators')
                        .upsert(indicators, { onConflict: 'symbol' });
                    if (upsertError) throw upsertError;
                    results.push({ symbol: sym, status: 'success' });
                } catch (err) {
                    results.push({ symbol: sym, status: 'failed', error: err.message });
                }
            }
        }
        const workers = Array(concurrency).fill().map(() => worker());
        await Promise.all(workers);

        return res.status(200).json({
            message: 'Update completed',
            total_symbols: uniqueSymbols.length,
            results,
        });
    } catch (err) {
        console.error('Update error:', err);
        return res.status(500).json({ error: 'Internal server error', details: err.message });
    }
}