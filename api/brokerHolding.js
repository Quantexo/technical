// api/brokerHolding.js — self-contained (PostgreSQL RPC + PostgREST fallback)
import { createClient } from '@supabase/supabase-js';

// ─── Supabase client — Broker Holdings DB ─
const supabaseUrl = process.env.SUPABASE_URL_2;
const supabaseKey = process.env.SUPABASE_ANON_KEY_2;
if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing SUPABASE_URL_2 or SUPABASE_ANON_KEY_2 environment variables');
}
const supabase = createClient(supabaseUrl, supabaseKey);

// ─── Supabase client — Main DB (for brokers list) ─
const supabaseMain = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─── Date helpers ────────────────────────────────────────────────────────────
function addDays(date, days) {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
}

function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// ─── Get distinct trading dates ─────────────────────────────────────────────
async function getDistinctTradingDates({ symbol, broker_id } = {}) {
    try {
        const { data, error } = await supabase.rpc('get_distinct_trading_dates', {
            p_symbol: symbol || null,
            p_broker_id: broker_id || null,
            p_limit: 30
        });
        if (!error && data && data.length > 0) {
            return data.map(r => (typeof r === 'string' ? r : r.date));
        }
    } catch (_) {}

    // Fallback mode: query top 200 rows to extract distinct dates instantly
    let q = supabase
        .from('broker_holding')
        .select('date')
        .order('date', { ascending: false })
        .limit(200);

    if (symbol) q = q.eq('symbol', symbol);
    if (broker_id) q = q.eq('broker_id', broker_id);

    const { data, error } = await q;
    if (error) throw new Error(`Failed to fetch dates: ${error.message}`);
    const dates = [...new Set(data?.map(r => r.date) || [])];
    return dates.sort((a, b) => (a > b ? -1 : 1));
}

// ─── Build the date range ───────────────────────────────────────────────────
async function buildDateRange({ date: specificDate, period, symbol, broker_id }) {
    if (specificDate) {
        return { startDate: specificDate, endDate: specificDate };
    }

    if (!period) {
        throw new Error('Either date or period must be provided');
    }

    let maxQuery = supabase
        .from('broker_holding')
        .select('date')
        .order('date', { ascending: false })
        .limit(1);

    if (symbol) maxQuery = maxQuery.eq('symbol', symbol);
    if (broker_id) maxQuery = maxQuery.eq('broker_id', broker_id);

    const { data: maxResult, error: maxError } = await maxQuery;
    if (maxError) throw new Error(`Failed to fetch max date: ${maxError.message}`);
    if (!maxResult || maxResult.length === 0) {
        throw new Error('No data found for the given filters');
    }

    const maxDate = new Date(maxResult[0].date + 'T00:00:00Z');
    const endDate = formatDate(maxDate);
    let startDate;

    switch (period) {
        case '1D':
            startDate = endDate;
            break;

        case '1W': {
            const uniqueDates = await getDistinctTradingDates({ symbol, broker_id });
            if (uniqueDates.length === 0) {
                throw new Error('No data found for the given filters');
            }
            startDate = uniqueDates.length >= 7 ? uniqueDates[6] : uniqueDates[uniqueDates.length - 1];
            break;
        }

        case '1M':  startDate = formatDate(addDays(maxDate, -30));  break;
        case '3M':  startDate = formatDate(addDays(maxDate, -90));  break;
        case '6M':  startDate = formatDate(addDays(maxDate, -180)); break;
        default:    throw new Error(`Invalid period: ${period}`);
    }

    return { startDate, endDate };
}

// ─── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const {
            date, period, symbol, memberId, type, page, limit,
            route, fields, sort_by, sort_order
        } = req.query;

        // ── Broker list sub-route ─────────────────────────────────────────────
        if (route === 'brokers') {
            const { data, error } = await supabaseMain
                .from('brokers')
                .select('broker_id, broker_name')
                .order('broker_id', { ascending: true });
            if (error) return res.status(500).json({ success: false, error: error.message });
            return res.status(200).json({ success: true, count: data.length, brokers: data });
        }

        // ── Determine data type (route) ──────────────────────────────────────
        let dataType = 'holding';    // default
        if (route === 'buy')  dataType = 'buy';
        if (route === 'sell') dataType = 'sell';
        if (route && !['buy', 'sell', 'brokers'].includes(route)) {
            return res.status(400).json({ error: 'Invalid route. Use buy, sell, or holding (default)' });
        }

        if (!date && !period) {
            return res.status(400).json({ error: 'Either date or period must be provided' });
        }
        if (date && period) {
            return res.status(400).json({ error: 'Provide either date or period, not both' });
        }

        if (type && dataType !== 'holding') {
            return res.status(400).json({ error: 'The type filter can only be used with the holding route' });
        }
        if (type && !['Buy', 'Sell'].includes(type)) {
            return res.status(400).json({ error: 'Type must be "Buy" or "Sell"' });
        }

        let broker_id = null;
        if (memberId) {
            broker_id = parseInt(memberId, 10);
            if (isNaN(broker_id)) {
                return res.status(400).json({ error: 'memberId must be a valid integer' });
            }
        }

        // ── Date range calculation ─────────────────────────────────────────
        const { startDate, endDate } = await buildDateRange({ date, period, symbol, broker_id });

        const pageNum  = parseInt(page  || '1',   10);
        const limitNum = parseInt(limit || '500', 10);
        const safeLimit = Math.min(Math.max(limitNum, 1), 1000);
        const offset = (pageNum - 1) * safeLimit;

        // ── Try PostgreSQL RPC Function (Server-side 50ms aggregation) ──────
        const { data: rpcData, error: rpcError } = await supabase.rpc('get_broker_holding_data', {
            p_start_date: startDate,
            p_end_date: endDate,
            p_symbol: symbol || null,
            p_broker_id: broker_id,
            p_route: dataType,
            p_type: type || null,
            p_sort_by: sort_by || null,
            p_sort_order: sort_order || 'asc',
            p_page: pageNum,
            p_limit: safeLimit
        });

        let summary, symbolSummary, brokerSummary, totalRecords, rows;

        if (!rpcError && rpcData) {
            summary = rpcData.summary;
            symbolSummary = rpcData.symbolSummary;
            brokerSummary = rpcData.brokerSummary;
            totalRecords = rpcData.total || 0;
            rows = rpcData.data || [];
        } else {
            // ── Fallback Mode if RPC function does not exist in Supabase DB yet ─
            console.warn('RPC function error or not installed, executing direct PostgREST query:', rpcError?.message);

            let selectStr = dataType === 'buy'   ? 'date, symbol, broker_id, buy_qty, buy_amount' :
                            dataType === 'sell'  ? 'date, symbol, broker_id, sell_qty, sell_amount' :
                                                   'date, symbol, broker_id, holding_qty, holding_amount';

            let query = supabase
                .from('broker_holding')
                .select(selectStr, { count: 'exact' })
                .gte('date', startDate)
                .lte('date', endDate)
                .range(offset, offset + safeLimit - 1);

            if (symbol) query = query.eq('symbol', symbol);
            if (broker_id) query = query.eq('broker_id', broker_id);
            if (dataType === 'holding' && type === 'Buy') query = query.gt('holding_qty', 0);
            if (dataType === 'holding' && type === 'Sell') query = query.lt('holding_qty', 0);

            const sortCol = sort_by || (dataType === 'buy' ? 'buy_qty' : dataType === 'sell' ? 'sell_qty' : 'holding_qty');
            query = query.order(sortCol, { ascending: sort_order !== 'desc' });

            const { data: fbData, count, error: fbError } = await query;
            if (fbError) throw new Error(`Database query failed: ${fbError.message}`);

            rows = fbData || [];
            totalRecords = count || rows.length;
            summary = {
                buyQuantity: 0, sellQuantity: 0, holdingQuantity: 0,
                buyAmount: 0, sellAmount: 0, netAmount: 0,
                averageBuyPrice: 0, averageSellPrice: 0
            };
        }

        // ── Field filtering ──────────────────────────────────────────────────
        const fieldMap = {
            buy:     ['date', 'symbol', 'broker_id', 'buy_qty', 'buy_amount'],
            sell:    ['date', 'symbol', 'broker_id', 'sell_qty', 'sell_amount'],
            holding: ['date', 'symbol', 'broker_id', 'holding_qty', 'holding_amount'],
        };
        const allowedFields = fieldMap[dataType];
        let selectedFields = allowedFields;
        if (fields) {
            const requested = fields.split(',').map(f => f.trim());
            selectedFields = requested.filter(f => allowedFields.includes(f));
            if (selectedFields.length === 0) selectedFields = allowedFields;
        }

        const mappedRows = rows.map(row => {
            const obj = {};
            for (const field of selectedFields) {
                if (field === 'date' || field === 'symbol' || field === 'broker_id') {
                    obj[field] = row[field];
                } else {
                    obj[field] = Number(row[field] || 0);
                }
            }
            return obj;
        });

        // ── Response structure ───────────────────────────────────────────────
        const response = {
            success: true,
            filters: {
                ...(date     && { date }),
                ...(period   && { period }),
                ...(symbol   && { symbol }),
                ...(broker_id !== null && { memberId: broker_id }),
                ...(type && dataType === 'holding' && { type }),
                route: dataType,
                startDate,
                endDate,
            },
            summary,
            ...(symbolSummary && symbolSummary.length > 0 && { symbolSummary }),
            ...(brokerSummary && brokerSummary.length > 0 && { brokerSummary }),
            pagination: {
                total:      totalRecords,
                page:       pageNum,
                limit:      safeLimit,
                totalPages: Math.ceil(totalRecords / safeLimit),
            },
            data: mappedRows,
        };

        if (totalRecords === 0) {
            response.message = 'No records found for the given filters';
        }

        return res.status(200).json(response);
    } catch (error) {
        console.error('API error:', error);
        const statusCode = error.message.includes('No data found') ? 404 : 400;
        return res.status(statusCode).json({ error: error.message });
    }
}
