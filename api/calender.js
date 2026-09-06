import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL_3;
const supabaseKey = process.env.SUPABASE_ANON_KEY_3;

if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing SUPABASE_URL_3 or SUPABASE_ANON_KEY_3 environment variables');
}

const supabase = createClient(supabaseUrl, supabaseKey);

function formatDate(date) {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Max-Age', '86400');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { symbol, event_type, from_date, to_date, limit, page, upcoming } = req.query;

        const pageNum = parseInt(page || '1', 10);
        const limitNum = parseInt(limit || '50', 10);
        const safeLimit = Math.min(Math.max(limitNum, 1), 200);
        const offset = (pageNum - 1) * safeLimit;

        let query = supabase
            .from('calendar')
            .select('*', { count: 'exact' });

        if (symbol) {
            query = query.ilike('symbol', `%${symbol}%`);
        }
        if (event_type) {
            const types = event_type.split(',');
            if (types.length === 1) {
                query = query.eq('event_type', types[0].trim());
            } else {
                query = query.in('event_type', types.map(t => t.trim()));
            }
        }

        const today = formatDate(new Date());
        if (upcoming === 'true') {
            query = query.gte('event_date', today);
        } else {
            if (from_date) {
                query = query.gte('event_date', from_date);
            }
            if (to_date) {
                query = query.lte('event_date', to_date);
            }
        }

        const { data, error, count } = await query
            .order('event_date', { ascending: upcoming === 'true' })
            .range(offset, offset + safeLimit - 1);

        if (error) {
            console.error('[Calendar] Query error:', error);
            return res.status(500).json({ success: false, error: error.message });
        }

        const formattedData = (data || []).map(row => ({
            id: row.id,
            event_type: row.event_type,
            symbol: row.symbol,
            company_name: row.company_name,
            event_date: row.event_date,
            description: row.description,
            details: row.details,
            created_at: row.created_at,
            updated_at: row.updated_at
        }));

        const eventTypeCounts = {};
        if (data) {
            data.forEach(row => {
                const type = row.event_type;
                eventTypeCounts[type] = (eventTypeCounts[type] || 0) + 1;
            });
        }

        return res.status(200).json({
            success: true,
            filters: {
                symbol:     symbol     || 'all',
                event_type: event_type || 'all',
                from_date:  from_date  || null,
                to_date:    to_date    || null,
                upcoming:   upcoming === 'true',
                today:      today
            },
            summary: {
                total:       count || 0,
                page:        pageNum,
                limit:       safeLimit,
                totalPages:  Math.ceil((count || 0) / safeLimit),
                eventTypeCounts
            },
            data: formattedData
        });

    } catch (error) {
        console.error('[Calendar] Error:', error);
        return res.status(500).json({
            success: false,
            error: error.message,
            stack: error.stack
        });
    }
}