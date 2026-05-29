import { createClient } from '@supabase/supabase-js';

// Helper to fetch average volume for a symbol over last N days
async function getAverageVolume(supabase, symbol, days) {
    const { data, error } = await supabase
        .from('prices')
        .select('volume')
        .eq('symbol', symbol)
        .order('date', { ascending: false })
        .limit(days);

    if (error) throw error;
    if (!data || data.length === 0) return null;

    const totalVolume = data.reduce((sum, row) => sum + parseInt(row.volume, 10), 0);
    return Math.round(totalVolume / data.length);
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

    // Extract path: /api/volume/all or /api/volume?symbol=...
    const urlParts = req.url.split('?');
    const basePath = urlParts[0];
    const queryParams = new URLSearchParams(urlParts[1] || '');

    // Case: /api/volume/all
    if (basePath.endsWith('/all')) {
        try {
            // Get all distinct symbols
            const { data: symbolsData, error: symbolsError } = await supabase
                .from('prices')
                .select('symbol')
                .order('symbol')
                .limit(200); // safety limit, adjust as needed

            if (symbolsError) throw symbolsError;
            const uniqueSymbols = [...new Set(symbolsData.map(row => row.symbol))];

            // For each symbol, get 20-day average volume
            const results = [];
            for (const sym of uniqueSymbols) {
                const avgVol = await getAverageVolume(supabase, sym, 20);
                results.push({
                    symbol: sym,
                    average_volume_20d: avgVol
                });
            }

            return res.status(200).json({
                symbols: results,
                days: 20,
                total_symbols: results.length
            });
        } catch (err) {
            console.error('Error in /all:', err);
            return res.status(500).json({ error: 'Failed to fetch all symbols volume' });
        }
    }

    // Case: /api/volume?symbol=... (with optional &days=...)
    const symbol = queryParams.get('symbol');
    if (!symbol) {
        return res.status(400).json({ error: 'Missing symbol parameter' });
    }

    let days = parseInt(queryParams.get('days'), 10);
    if (isNaN(days) || days < 1) days = 20; // default 20 days

    try {
        const avgVolume = await getAverageVolume(supabase, symbol, days);
        if (avgVolume === null) {
            return res.status(404).json({ error: `No volume data found for symbol ${symbol}` });
        }

        return res.status(200).json({
            symbol: symbol.toUpperCase(),
            average_volume: avgVolume,
            days_used: days
        });
    } catch (err) {
        console.error('Volume error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
} s