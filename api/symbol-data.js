import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  // ─── CORS HEADERS ──────────────────────────────────────────────────
  const origin = req.headers.origin;
  
  // Define allowed origins
  const allowedOrigins = [
    'http://localhost:5600',
    'http://localhost:3000',
    'https://nepse-hub.vercel.app',
    'https://nepse-hub-backend.vercel.app',
    // Add any other domains you use
  ];

  // Check if the origin is allowed
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  } else {
    // For development - allow all origins (remove in production)
    res.setHeader('Access-Control-Allow-Origin', '*');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400'); // Cache preflight for 24 hours
  res.setHeader('Vary', 'Origin');

  // ─── HANDLE OPTIONS (Preflight) ────────────────────────────────────
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ─── MAIN REQUEST HANDLING ────────────────────────────────────────
  const { symbol, start_date, end_date } = req.query;

  if (!symbol) {
    return res.status(400).json({ error: 'Missing symbol parameter' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
  
  if (!supabaseUrl || !supabaseKey) {
    console.error('❌ Supabase credentials missing');
    return res.status(500).json({ error: 'Supabase credentials missing' });
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseKey);
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
    
    if (error) {
      console.error('❌ Supabase query error:', error);
      throw error;
    }

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
    console.error('❌ Symbol-data error:', err);
    return res.status(500).json({ 
      error: 'Internal server error', 
      details: err.message 
    });
  }
}