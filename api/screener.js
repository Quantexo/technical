import { createClient } from '@supabase/supabase-js';

// ----------------------------------------------
// Technical Indicator Functions
// ----------------------------------------------

// Simple Moving Average (returns array of same length with nulls for insufficient data)
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

// Exponential Moving Average (returns array)
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

// RSI (returns array)
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

// MACD (12,26,9) – returns { macd: [], signal: [], histogram: [] }
function MACD(prices, fast = 12, slow = 26, signalPeriod = 9) {
    const emaFast = EMA(prices, fast);
    const emaSlow = EMA(prices, slow);
    const macdLine = emaFast.map((v, i) => (v !== null && emaSlow[i] !== null) ? v - emaSlow[i] : null);
    const signalLine = EMA(macdLine.filter(v => v !== null), signalPeriod);
    // align signal line to same indices (pad nulls at start)
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

// Average True Range (ATR) – needs high, low, close arrays
function ATR(high, low, close, period = 14) {
    const tr = new Array(high.length).fill(null);
    for (let i = 1; i < high.length; i++) {
        const hl = high[i] - low[i];
        const hc = Math.abs(high[i] - close[i - 1]);
        const lc = Math.abs(low[i] - close[i - 1]);
        tr[i] = Math.max(hl, hc, lc);
    }
    // first true range is just high-low of first day
    if (high.length > 0) tr[0] = high[0] - low[0];

    // SMA of true ranges for first period, then Wilder's smoothing
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

// On-Balance Volume (OBV)
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

// Helper to get last non-null value from array
function lastNonNull(arr) {
    for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i] !== null && !isNaN(arr[i])) return arr[i];
    }
    return null;
}

// ----------------------------------------------
// Vercel Serverless Function Handler
// ----------------------------------------------
export default async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const { symbol, limit = 300 } = req.query; // fetch at least 300 days for 200-day MA
    if (!symbol) return res.status(400).json({ error: 'Missing symbol parameter' });

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseKey) {
        return res.status(500).json({ error: 'Supabase credentials missing' });
    }
    const supabase = createClient(supabaseUrl, supabaseKey);

    try {
        // Fetch data: need date, open, high, low, close, volume – ordered newest first, but we'll reverse
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

        // Reverse to get chronological order (oldest → newest)
        data.reverse();

        const closePrices = data.map(d => parseFloat(d.close));
        const highPrices = data.map(d => parseFloat(d.high));
        const lowPrices = data.map(d => parseFloat(d.low));
        const volumes = data.map(d => parseInt(d.volume, 10));
        const dates = data.map(d => d.date);

        // Calculate all indicators
        const sma200 = SMA(closePrices, 200);
        const ema200 = EMA(closePrices, 200);
        const rsi14 = RSI(closePrices, 14);
        const { macd, signal, histogram } = MACD(closePrices, 12, 26, 9);
        const atr14 = ATR(highPrices, lowPrices, closePrices, 14);
        const obv = OBV(closePrices, volumes);

        // Get latest values (last index)
        const lastIdx = closePrices.length - 1;
        const latestSMA = sma200[lastIdx];
        const latestEMA = ema200[lastIdx];
        const latestRSI = rsi14[lastIdx];
        const latestMACD = macd[lastIdx];
        const latestSignal = signal[lastIdx];
        const latestHistogram = histogram[lastIdx];
        const latestATR = atr14[lastIdx];
        const latestOBV = obv[lastIdx];
        const latestClose = closePrices[lastIdx];
        const latestDate = dates[lastIdx];

        // Also return SMA200 and EMA200 values for reference if needed (optional)
        const response = {
            symbol: symbol.toUpperCase(),
            latest_traded_date: latestDate,
            records_used: data.length,
            indicators: {
                sma_200: latestSMA !== null ? parseFloat(latestSMA.toFixed(2)) : null,
                ema_200: latestEMA !== null ? parseFloat(latestEMA.toFixed(2)) : null,
                rsi_14: latestRSI !== null ? parseFloat(latestRSI.toFixed(2)) : null,
                macd: {
                    macd_line: latestMACD !== null ? parseFloat(latestMACD.toFixed(4)) : null,
                    signal_line: latestSignal !== null ? parseFloat(latestSignal.toFixed(4)) : null,
                    histogram: latestHistogram !== null ? parseFloat(latestHistogram.toFixed(4)) : null,
                },
                atr_14: latestATR !== null ? parseFloat(latestATR.toFixed(2)) : null,
                obv: latestOBV !== null ? Math.round(latestOBV) : null,
                latest_close: parseFloat(latestClose.toFixed(2)),
            }
        };

        return res.status(200).json(response);
    } catch (err) {
        console.error('Screener error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
}