import { createClient } from '@supabase/supabase-js';

// ------------------------------------------------------------
// Faster, leaner indicator functions
// ------------------------------------------------------------
function SMA(values, period) {
    if (values.length < period) return new Array(values.length).fill(null);
    const result = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < period - 1; i++) sum += values[i];
    for (let i = period - 1; i < values.length; i++) {
        sum += values[i];
        result[i] = sum / period;
        sum -= values[i - (period - 1)];
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
    let avgGain = gains / period;
    let avgLoss = losses / period;
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

// Optional: keep MACD but compute only if needed – we'll keep for completeness
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

function detectCrossover(fastMA, slowMA) {
    if (fastMA.length < 2 || slowMA.length < 2) return { status: null, signal: null, fast: null, slow: null };
    const lastIdx = fastMA.length - 1;
    const fastNow = fastMA[lastIdx];
    const slowNow = slowMA[lastIdx];
    if (fastNow === null || slowNow === null) return { status: null, signal: null, fast: fastNow, slow: slowNow };
    const fastPrev = fastMA[lastIdx - 1];
    const slowPrev = slowMA[lastIdx - 1];
    let status = fastNow > slowNow ? 'bullish' : (fastNow < slowNow ? 'bearish' : 'neutral');
    let signal = 'none';
    if (fastPrev !== null && slowPrev !== null) {
        if (fastPrev <= slowPrev && fastNow > slowNow) signal = 'golden_cross';
        else if (fastPrev >= slowPrev && fastNow < slowNow) signal = 'death_cross';
    }
    return { status, signal, fast: fastNow, slow: slowNow };
}

// ------------------------------------------------------------
// Process a single symbol (only 200 days)
// ------------------------------------------------------------
async function processSymbol(supabase, symbol, limit = 200) {
    const start = Date.now();
    try {
        const { data, error } = await supabase
            .from('prices')
            .select('date, open, high, low, close, volume')
            .eq('symbol', symbol)
            .order('date', { ascending: false })
            .limit(limit);
        if (error) throw error;
        if (!data || data.length < 50) throw new Error('Insufficient data');
        data.reverse(); // oldest first

        const close = data.map(d => parseFloat(d.close));
        const high = data.map(d => parseFloat(d.high));
        const low = data.map(d => parseFloat(d.low));
        const vol = data.map(d => parseInt(d.volume, 10));

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

        const last = close.length - 1;
        const lastDate = data[last].date;

        return {
            symbol,
            latest_traded_date: lastDate,
            indicators: {
                rsi_14: rsi[last] ? parseFloat(rsi[last].toFixed(2)) : null,
                macd: {
                    macd_line: macd[last] ? parseFloat(macd[last].toFixed(4)) : null,
                    signal_line: signal[last] ? parseFloat(signal[last].toFixed(4)) : null,
                    histogram: histogram[last] ? parseFloat(histogram[last].toFixed(4)) : null,
                },
                atr_14: atr[last] ? parseFloat(atr[last].toFixed(2)) : null,
                obv: obv[last] ? Math.round(obv[last]) : null,
                latest_close: parseFloat(close[last].toFixed(2)),
                moving_average_crossovers: {
                    golden_cross_death_cross: {
                        fast_value: golden.fast ? parseFloat(golden.fast.toFixed(2)) : null,
                        slow_value: golden.slow ? parseFloat(golden.slow.toFixed(2)) : null,
                        status: golden.status,
                        signal: golden.signal,
                    },
                    short_term_cross: {
                        fast_value: short.fast ? parseFloat(short.fast.toFixed(2)) : null,
                        slow_value: short.slow ? parseFloat(short.slow.toFixed(2)) : null,
                        status: short.status,
                        signal: short.signal,
                    },
                    swing_trading_cross: {
                        fast_value: swing.fast ? parseFloat(swing.fast.toFixed(2)) : null,
                        slow_value: swing.slow ? parseFloat(swing.slow.toFixed(2)) : null,
                        status: swing.status,
                        signal: swing.signal,
                    },
                    medium_term_cross: {
                        fast_value: medium.fast ? parseFloat(medium.fast.toFixed(2)) : null,
                        slow_value: medium.slow ? parseFloat(medium.slow.toFixed(2)) : null,
                        status: medium.status,
                        signal: medium.signal,
                    },
                },
            },
        };
    } catch (err) {
        return { symbol, error: err.message };
    }
}

// Concurrency limiter (max N at once)
async function processAll(supabase, symbols, concurrency = 10) {
    const results = [];
    const queue = [...symbols];
    async function worker() {
        while (queue.length) {
            const sym = queue.shift();
            const res = await processSymbol(supabase, sym);
            results.push(res);
        }
    }
    const workers = Array(concurrency).fill().map(() => worker());
    await Promise.all(workers);
    return results;
}

// ------------------------------------------------------------
// Main handler
// ------------------------------------------------------------
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

    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const offset = (page - 1) * limit;

        // Get all symbols (once, using efficient query)
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
        const totalSymbols = uniqueSymbols.length;
        const totalPages = Math.ceil(totalSymbols / limit);
        const symbolsToProcess = uniqueSymbols.slice(offset, offset + limit);
        if (symbolsToProcess.length === 0) {
            return res.status(404).json({ error: 'Page not found' });
        }

        // Process with high concurrency (10 at a time)
        const results = await processAll(supabase, symbolsToProcess, 10);

        return res.status(200).json({
            pagination: {
                current_page: page,
                per_page: limit,
                total_symbols: totalSymbols,
                total_pages: totalPages,
            },
            results,
        });
    } catch (err) {
        console.error('Screener-all error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
}