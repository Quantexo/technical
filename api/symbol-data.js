import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const ALLOWED_ORIGINS = [
    'http://localhost:5600',
    'http://localhost:5500',
    'https://nepsehub.vercel.app',
  ];
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbol, start_date, end_date } = req.query;

  if (!symbol) {
    return res.status(400).json({ error: 'Missing symbol parameter' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: 'Supabase credentials missing' });
  }
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const symbolUpper = symbol.toUpperCase();
    
    let query = supabase
      .from('prices')
      .select('date, open, high, low, close, volume')
      .eq('symbol', symbolUpper)
      .order('date', { ascending: true });

    // Apply date filters
    if (start_date) {
      query = query.gte('date', start_date);
    } else {
      // Default to last 1 year if start_date is not specified
      const oneYearAgo = new Date();
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
      const formattedDate = oneYearAgo.toISOString().split('T')[0];
      query = query.gte('date', formattedDate);
    }

    if (end_date) {
      query = query.lte('date', end_date);
    }

    const { data, error } = await query;
    if (error) throw error;

    const mappedCandles = (data || []).map(d => ({
      Date: d.date,
      Open: parseFloat(d.open || 0),
      High: parseFloat(d.high || 0),
      Low: parseFloat(d.low || 0),
      Close: parseFloat(d.close || 0),
      Volume: parseInt(d.volume || 0, 10)
    }));

    return res.status(200).json({
      success: true,
      data: mappedCandles
    });
  } catch (err) {
    console.error('Symbol-data error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
}
