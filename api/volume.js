import { createClient } from '@supabase/supabase-js';

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

    // Check environment variables first
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseKey) {
        console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY');
        return res.status(500).json({ error: 'Server misconfigured: missing Supabase credentials' });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    try {
        // Parse URL manually (Vercel provides req.url)
        const url = new URL(req.url, `http://${req.headers.host}`);
        const pathname = url.pathname;

        // Case: /api/volume/all
        if (pathname.endsWith('/all')) {
            // Get all unique symbols (using a more efficient query)
            const { data: symbolsData, error: symbolsError } = await supabase
                .from('prices')
                .select('symbol')
                .order('symbol')
                .limit(500); // increase if needed

            if (symbolsError) throw symbolsError;
            const uniqueSymbols = [...new Set(symbolsData.map(row => row.symbol))];

            const results = [];
            for (const sym of uniqueSymbols) {
                try {
                    const avgVol = await getAverageVolume(supabase, sym, 20);
                    results.push({ symbol: sym, average_volume_20d: avgVol });
                } catch (err) {
                    console.error(`Error processing symbol ${sym}:`, err.message);
                    results.push({ symbol: sym, average_volume_20d: null, error: err.message });
                }
            }

            return res.status(200).json({
                symbols: results,
                days: 20,
                total_symbols: results.length
            });
        }

        // Case: /api/volume?symbol=...
        const symbol = url.searchParams.get('symbol');
        if (!symbol) {
            return res.status(400).json({ error: 'Missing symbol parameter' });
        }

        let days = parseInt(url.searchParams.get('days'), 10);
        if (isNaN(days) || days < 1) days = 20;

        const avgVolume = await getAverageVolume(supabase, symbol.toUpperCase(), days);
        if (avgVolume === null) {
            return res.status(404).json({ error: `No volume data found for symbol ${symbol}` });
        }

        return res.status(200).json({
            symbol: symbol.toUpperCase(),
            average_volume: avgVolume,
            days_used: days
        });
    } catch (err) {
        console.error('Unhandled error in volume.js:', err);
        return res.status(500).json({ error: 'Internal server error', details: err.message });
    }
}