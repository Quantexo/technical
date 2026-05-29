import { createClient } from '@supabase/supabase-js';

// Helper: get average volume for a given symbol over last N days
async function getAverageVolume(supabase, symbol, days) {
    const { data, error } = await supabase
        .from('prices')
        .select('volume')
        .eq('symbol', symbol)
        .order('date', { ascending: false })
        .limit(days);
    if (error) throw error;
    if (!data || data.length === 0) return null;
    const total = data.reduce((sum, row) => sum + Number(row.volume), 0);
    return Math.round(total / data.length);
}

export default async function handler(req, res) {
    // CORS
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

    // Parse the full request URL to detect /all endpoint
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // CASE: /api/volume/all (rewritten from /api/volume/all to /api/volume)
    if (pathname.endsWith('/all')) {
        try {
            // Get all distinct symbols – fetch many rows and deduplicate
            const { data: allRows, error: fetchError } = await supabase
                .from('prices')
                .select('symbol')
                .limit(10000); // high enough to cover all symbols
            if (fetchError) throw fetchError;

            const uniqueSymbols = [...new Set(allRows.map(row => row.symbol))];
            const results = [];

            for (const sym of uniqueSymbols) {
                try {
                    const avgVol = await getAverageVolume(supabase, sym, 20);
                    results.push({ symbol: sym, average_volume_20d: avgVol });
                } catch (err) {
                    results.push({ symbol: sym, average_volume_20d: null, error: err.message });
                }
            }

            return res.status(200).json({
                symbols: results,
                days: 20,
                total_symbols: results.length,
            });
        } catch (err) {
            console.error('Volume-all error:', err);
            return res.status(500).json({ error: 'Failed to fetch all symbols volume' });
        }
    }

    // CASE: /api/volume?symbol=XYZ (single symbol)
    const symbol = url.searchParams.get('symbol');
    if (!symbol) {
        return res.status(400).json({ error: 'Missing symbol parameter' });
    }

    let days = parseInt(url.searchParams.get('days'), 10);
    if (isNaN(days) || days < 1) days = 20;

    try {
        const avgVolume = await getAverageVolume(supabase, symbol.toUpperCase(), days);
        if (avgVolume === null) {
            return res.status(404).json({ error: `No volume data found for symbol ${symbol}` });
        }
        return res.status(200).json({
            symbol: symbol.toUpperCase(),
            average_volume: avgVolume,
            days_used: days,
        });
    } catch (err) {
        console.error('Volume error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
}