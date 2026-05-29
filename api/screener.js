import { createClient } from '@supabase/supabase-js';

// ----------------------------------------------
// Indicator Helpers (same as before)
// ----------------------------------------------
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
    let signalIdx = 0;
    for (let i = 0; i < macdLine.length; i++) {
        if (macdLine[i] !== null && signalIdx < signalLine.length) {
            alignedSignal[i] = signalLine[signalIdx];
            signalIdx++;
        }
    }
    const histogram = macdLine.map((v, i) => (v !== null && alignedSignal[i] !== null) ? v - alignedSignal[i] : null);
    return { macd: macdLine, signal: alignedSignal, histogram };
}

function ATR(high, low, close, period = 14) {
    const tr = new Array(high.length).fill(null);
    for (let i = 1; i < high.length; i++) {
        const hl = high[i] - low[i];
        const hc = Math.abs(high[i] - close[i - 1]);
        const lc = Math.abs(low[i] - close[i - 1]);
        tr[i] = Math.max(hl, hc, lc);
    }
    if (high.length > 0) tr[0] = high[0] - low[0];
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

// Helper to get last non‑null value
function lastNonNull(arr) {
    for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i] !== null && !isNaN(arr[i])) return arr[i];
    }
    return null;
}

// ------------------------------------------------------------
// Crossover detection for a pair of MA arrays (fast, slow)
// Returns current status and if crossover happened in last day
// ------------------------------------------------------------
function detectCrossover(fastMA, slowMA) {
    if (fastMA.length < 2 || slowMA.length < 2) return { status: null, signal: null, fast: null, slow: null };
    const lastIdx = fastMA.length - 1;
    const fastNow = fastMA[lastIdx];
    const slowNow = slowMA[lastIdx];
    if (fastNow === null || slowNow === null) return { status: null, signal: null, fast: fastNow, slow: slowNow };

    const fastPrev = fastMA[lastIdx - 1];
    const slowPrev = slowMA[lastIdx - 1];
    let status = 'neutral';
    if (fastNow > slowNow) status = 'bullish';      // fast above slow
    else if (fastNow < slowNow) status = 'bearish'; // fast below slow

    let signal = 'none';
    // Crossover if previous relationship was opposite
    if (fastPrev !== null && slowPrev !== null) {
        if (fastPrev <= slowPrev && fastNow > slowNow) signal = 'golden_cross';      // cross above
        else if (fastPrev >= slowPrev && fastNow < slowNow) signal = 'death_cross'; // cross below
    }
    return { status, signal, fast: fastNow, slow: slowNow };
}

// ------------------------------------------------------------
// Vercel Handler
// ------------------------------------------------------------
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const { symbol, limit = 300 } = req.query;
    if (!symbol) return res.status(400).json({ error: 'Missing symbol parameter' });

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseKey) {
        return res.status(500).json({ error: 'Supabase credentials missing' });
    }
    const supabase = createClient(supabaseUrl, supabaseKey);

    try {
        const { data, error } = await supabase
            .from('prices')
            .select('date, open, high, low, close, volume')
            .eq('symbol', symbol.toUpperCase())
            .order('date', { ascending: false })
            .limit(parseInt(limit, 10));

        if (error) throw error;
        if (!data || data.length === 0) {
            return res.status(404).json({ error: `No data for symbol ${symbol}` });
        }

        data.reverse(); // oldest → newest

        const closePrices = data.map(d => parseFloat(d.close));
        const highPrices = data.map(d => parseFloat(d.high));
        const lowPrices = data.map(d => parseFloat(d.low));
        const volumes = data.map(d => parseInt(d.volume, 10));
        const dates = data.map(d => d.date);

        // Compute all required MAs
        const sma50 = SMA(closePrices, 50);
        const sma200 = SMA(closePrices, 200);
        const ema9 = EMA(closePrices, 9);
        const ema21 = EMA(closePrices, 21);
        const ema20 = EMA(closePrices, 20);
        const ema50 = EMA(closePrices, 50);
        const ema100 = EMA(closePrices, 100);

        // Detect crossovers
        const goldenCross = detectCrossover(sma50, sma200);
        const shortCross = detectCrossover(ema9, ema21);
        const swingCross = detectCrossover(ema20, ema50);
        const mediumCross = detectCrossover(ema50, ema100);

        // Other indicators (RSI, MACD, ATR, OBV) from previous version
        const rsi14 = RSI(closePrices, 14);
        const { macd, signal, histogram } = MACD(closePrices);
        const atr14 = ATR(highPrices, lowPrices, closePrices, 14);
        const obv = OBV(closePrices, volumes);

        const lastIdx = closePrices.length - 1;
        const latestDate = dates[lastIdx];
        const latestClose = closePrices[lastIdx];

        const response = {
            symbol: symbol.toUpperCase(),
            latest_traded_date: latestDate,
            records_used: data.length,
            indicators: {
                rsi_14: rsi14[lastIdx] !== null ? parseFloat(rsi14[lastIdx].toFixed(2)) : null,
                macd: {
                    macd_line: macd[lastIdx] !== null ? parseFloat(macd[lastIdx].toFixed(4)) : null,
                    signal_line: signal[lastIdx] !== null ? parseFloat(signal[lastIdx].toFixed(4)) : null,
                    histogram: histogram[lastIdx] !== null ? parseFloat(histogram[lastIdx].toFixed(4)) : null,
                },
                atr_14: atr14[lastIdx] !== null ? parseFloat(atr14[lastIdx].toFixed(2)) : null,
                obv: obv[lastIdx] !== null ? Math.round(obv[lastIdx]) : null,
                latest_close: parseFloat(latestClose.toFixed(2)),
                moving_average_crossovers: {
                    golden_cross_death_cross: {
                        name: "Golden Cross / Death Cross",
                        fast_ma: "SMA 50",
                        slow_ma: "SMA 200",
                        fast_value: goldenCross.fast !== null ? parseFloat(goldenCross.fast.toFixed(2)) : null,
                        slow_value: goldenCross.slow !== null ? parseFloat(goldenCross.slow.toFixed(2)) : null,
                        status: goldenCross.status,    // bullish (fast above slow) or bearish
                        signal: goldenCross.signal     // golden_cross, death_cross, or none
                    },
                    short_term_cross: {
                        name: "Short-term Cross",
                        fast_ma: "EMA 9",
                        slow_ma: "EMA 21",
                        fast_value: shortCross.fast !== null ? parseFloat(shortCross.fast.toFixed(2)) : null,
                        slow_value: shortCross.slow !== null ? parseFloat(shortCross.slow.toFixed(2)) : null,
                        status: shortCross.status,
                        signal: shortCross.signal
                    },
                    swing_trading_cross: {
                        name: "Swing Trading Cross",
                        fast_ma: "EMA 20",
                        slow_ma: "EMA 50",
                        fast_value: swingCross.fast !== null ? parseFloat(swingCross.fast.toFixed(2)) : null,
                        slow_value: swingCross.slow !== null ? parseFloat(swingCross.slow.toFixed(2)) : null,
                        status: swingCross.status,
                        signal: swingCross.signal
                    },
                    medium_term_cross: {
                        name: "Medium-term Cross",
                        fast_ma: "EMA 50",
                        slow_ma: "EMA 100",
                        fast_value: mediumCross.fast !== null ? parseFloat(mediumCross.fast.toFixed(2)) : null,
                        slow_value: mediumCross.slow !== null ? parseFloat(mediumCross.slow.toFixed(2)) : null,
                        status: mediumCross.status,
                        signal: mediumCross.signal
                    }
                }
            }
        };

        return res.status(200).json(response);
    } catch (err) {
        console.error('Screener error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
}