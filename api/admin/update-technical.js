import { createClient } from '@supabase/supabase-js';

// Copy all indicator functions from screener.js (SMA, EMA, RSI, MACD, ATR, OBV, detectCrossover)
// ... (paste the same functions here to keep this file self-contained)

// For brevity, I'll assume you have them. In production, you'd import shared utils.
// I'll include the minimal set.

function SMA(values, period) { /* same as before */ }
function EMA(values, period) { /* same */ }
function RSI(values, period) { /* same */ }
function MACD(prices) { /* same */ }
function ATR(high, low, close) { /* same */ }
function OBV(close, volume) { /* same */ }
function detectCrossover(fastMA, slowMA) { /* same */ }

async function processSymbol(supabase, symbol, limit = 200) {
    // same as in screener-all.js but return flat object for DB
    try {
        const { data, error } = await supabase
            .from('prices')
            .select('date, open, high, low, close, volume')
            .eq('symbol', symbol)
            .order('date', { ascending: false })
            .limit(limit);
        if (error) throw error;
        if (!data || data.length < 50) throw new Error('Insufficient data');
        data.reverse();

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
            rsi_14: rsi[last] ? parseFloat(rsi[last].toFixed(2)) : null,
            macd_line: macd[last] ? parseFloat(macd[last].toFixed(4)) : null,
            macd_signal: signal[last] ? parseFloat(signal[last].toFixed(4)) : null,
            macd_histogram: histogram[last] ? parseFloat(histogram[last].toFixed(4)) : null,
            atr_14: atr[last] ? parseFloat(atr[last].toFixed(2)) : null,
            obv: obv[last] ? Math.round(obv[last]) : null,
            latest_close: parseFloat(close[last].toFixed(2)),
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

export default async function handler(req, res) {
    // Secret protection
    const authHeader = req.headers.authorization;
    const expectedSecret = process.env.ADMIN_SECRET;

    if (!expectedSecret || !authHeader || authHeader !== `Bearer ${expectedSecret}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY; // use service role for write
    if (!supabaseUrl || !supabaseKey) {
        return res.status(500).json({ error: 'Supabase credentials missing' });
    }
    const supabase = createClient(supabaseUrl, supabaseKey);

    try {
        // Get all distinct symbols
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
        const results = [];

        // Process with concurrency 5 to avoid rate limits
        const concurrency = 5;
        const queue = [...uniqueSymbols];
        async function worker() {
            while (queue.length) {
                const sym = queue.shift();
                try {
                    const indicators = await processSymbol(supabase, sym);
                    // Upsert into technical_indicators
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
        return res.status(500).json({ error: 'Internal server error' });
    }
}