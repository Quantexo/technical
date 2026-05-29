import { createClient } from '@supabase/supabase-js';

// ----------------------------------------------
// Technical indicator calculations
// ----------------------------------------------

// Simple Moving Average (last value only)
function calculateSMA(data, period) {
    if (data.length < period) return null;
    const sum = data.slice(-period).reduce((a, b) => a + b, 0);
    return sum / period;
}

// RSI (Relative Strength Index) – last value
function calculateRSI(prices, period = 14) {
    if (prices.length < period + 1) return null;

    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        const diff = prices[i] - prices[i - 1];
        if (diff >= 0) gains += diff;
        else losses -= diff;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;

    for (let i = period + 1; i < prices.length; i++) {
        const diff = prices[i] - prices[i - 1];
        if (diff >= 0) {
            avgGain = (avgGain * (period - 1) + diff) / period;
            avgLoss = (avgLoss * (period - 1)) / period;
        } else {
            avgGain = (avgGain * (period - 1)) / period;
            avgLoss = (avgLoss * (period - 1) - diff) / period;
        }
    }

    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

// Average volume and latest volume
function getVolumeStats(volumes) {
    if (!volumes.length) return { latestVolume: null, averageVolume: null };
    const sum = volumes.reduce((a, b) => a + b, 0);
    return {
        latestVolume: volumes[volumes.length - 1],
        averageVolume: sum / volumes.length
    };
}

// ----------------------------------------------
// Main API handler for Vercel
// ----------------------------------------------
export default async function handler(req, res) {
    // Enable CORS (adjust for production)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { symbol, period = 14, limit = 200 } = req.query;

    if (!symbol) {
        return res.status(400).json({ error: 'Missing required query parameter: symbol' });
    }

    const periodNum = parseInt(period, 10);
    const limitNum = parseInt(limit, 10);

    // Validate inputs
    if (isNaN(periodNum) || periodNum < 2) {
        return res.status(400).json({ error: 'Period must be a number >= 2' });
    }
    if (isNaN(limitNum) || limitNum < periodNum) {
        return res.status(400).json({ error: `Limit must be at least ${periodNum}` });
    }

    // Supabase client
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseKey) {
        return res.status(500).json({ error: 'Server configuration missing Supabase credentials' });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    try {
        // Fetch latest N records for the symbol (ascending date)
        const { data, error } = await supabase
            .from('prices')
            .select('close, volume')
            .eq('symbol', symbol.toUpperCase())
            .order('date', { ascending: true })
            .limit(limitNum);

        if (error) throw error;
        if (!data || data.length === 0) {
            return res.status(404).json({ error: `No price data found for symbol ${symbol}` });
        }

        const closes = data.map(row => parseFloat(row.close));
        const volumes = data.map(row => parseInt(row.volume, 10));

        // Calculate indicators
        const sma = calculateSMA(closes, periodNum);
        const rsi = calculateRSI(closes, periodNum);
        const avgPrice = closes.reduce((a, b) => a + b, 0) / closes.length;
        const { latestVolume, averageVolume } = getVolumeStats(volumes);

        return res.status(200).json({
            symbol: symbol.toUpperCase(),
            period: periodNum,
            records_used: data.length,
            indicators: {
                rsi: rsi !== null ? parseFloat(rsi.toFixed(2)) : null,
                sma: sma !== null ? parseFloat(sma.toFixed(2)) : null,
                avg_price: parseFloat(avgPrice.toFixed(2)),
                latest_volume: latestVolume,
                average_volume: averageVolume !== null ? Math.round(averageVolume) : null
            }
        });
    } catch (err) {
        console.error('API error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
}