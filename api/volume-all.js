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
        // Get distinct symbols
        const { data: symbolsData, error: symbolsError } = await supabase
            .from('prices')
            .select('symbol')
            .order('symbol')
            .limit(500); // adjust as needed

        if (symbolsError) throw symbolsError;
        const uniqueSymbols = [...new Set(symbolsData.map(row => row.symbol))];

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
            total_symbols: results.length
        });
    } catch (err) {
        console.error('Volume-all error:', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
}