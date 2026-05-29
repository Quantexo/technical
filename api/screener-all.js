import { createClient } from '@supabase/supabase-js';

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

        // Count total symbols
        const { count: totalSymbols, error: countError } = await supabase
            .from('technical_indicators')
            .select('*', { count: 'exact', head: true });
        if (countError) throw countError;

        const totalPages = Math.ceil(totalSymbols / limit);
        const { data, error } = await supabase
            .from('technical_indicators')
            .select('*')
            .order('symbol')
            .range(offset, offset + limit - 1);

        if (error) throw error;

        // Reformat to match original screener output
        const results = data.map(row => ({
            symbol: row.symbol,
            latest_traded_date: row.latest_traded_date,
            indicators: {
                rsi_14: row.rsi_14,
                macd: {
                    macd_line: row.macd_line,
                    signal_line: row.macd_signal,
                    histogram: row.macd_histogram,
                },
                atr_14: row.atr_14,
                obv: row.obv,
                latest_close: row.latest_close,
                moving_average_crossovers: {
                    golden_cross_death_cross: {
                        fast_value: row.golden_cross_fast,
                        slow_value: row.golden_cross_slow,
                        status: row.golden_cross_status,
                        signal: row.golden_cross_signal,
                    },
                    short_term_cross: {
                        fast_value: row.short_cross_fast,
                        slow_value: row.short_cross_slow,
                        status: row.short_cross_status,
                        signal: row.short_cross_signal,
                    },
                    swing_trading_cross: {
                        fast_value: row.swing_cross_fast,
                        slow_value: row.swing_cross_slow,
                        status: row.swing_cross_status,
                        signal: row.swing_cross_signal,
                    },
                    medium_term_cross: {
                        fast_value: row.medium_cross_fast,
                        slow_value: row.medium_cross_slow,
                        status: row.medium_cross_status,
                        signal: row.medium_cross_signal,
                    },
                },
            },
        }));

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