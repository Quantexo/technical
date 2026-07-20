// api/brokerHolding.js — self-contained (lib + utils merged in)
import { createClient } from '@supabase/supabase-js';

// ─── Supabase client — Broker Holdings DB (SUPABASE_URL_2 / SUPABASE_ANON_KEY_2) ─
const supabaseUrl = process.env.SUPABASE_URL_2;
const supabaseKey = process.env.SUPABASE_ANON_KEY_2;
if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing SUPABASE_URL_2 or SUPABASE_ANON_KEY_2 environment variables');
}
const supabase = createClient(supabaseUrl, supabaseKey);

// ─── Supabase client — Main DB (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY) ──────
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

// ─── Calculations ─────────────────────────────────────────────────────────────
function computeSummary(rows) {
    let totalHoldingQty = 0;
    let totalHoldingAmount = 0;

    for (const row of rows) {
        if (row.holding_qty !== undefined) {
            totalHoldingQty += Number(row.holding_qty || 0);
        } else {
            totalHoldingQty += Number(row.buy_qty || 0) - Number(row.sell_qty || 0);
        }

        if (row.holding_amount !== undefined) {
            totalHoldingAmount += Number(row.holding_amount || 0);
        } else {
            totalHoldingAmount += Number(row.buy_amount || 0) - Number(row.sell_amount || 0);
        }
    }

    return {
        buyQuantity: 0,
        sellQuantity: 0,
        holdingQuantity: totalHoldingQty,
        buyAmount: 0,
        sellAmount: 0,
        netAmount: totalHoldingAmount,
        averageBuyPrice: 0,
        averageSellPrice: 0,
    };
}

// ─── Fetch ALL rows with automatic pagination (Supabase caps at 1000/req) ─────
async function fetchAllRows(baseQuery, selectStr, filters, dateFilter) {
    const PAGE_SIZE = 1000;
    let allRows = [];
    let from = 0;

    while (true) {
        let q = supabase
            .from('broker_holding')
            .select(selectStr)
            .gte('date', dateFilter.startDate)
            .lte('date', dateFilter.endDate)
            .order('date', { ascending: false })
            .range(from, from + PAGE_SIZE - 1);

        if (filters.symbol) q = q.eq('symbol', filters.symbol);
        if (filters.broker_id) q = q.eq('broker_id', filters.broker_id);

        const { data, error } = await q;
        if (error) throw new Error(`Database query failed: ${error.message}`);
        if (!data || data.length === 0) break;

        allRows = allRows.concat(data);
        if (data.length < PAGE_SIZE) break;  // Last page reached
        from += PAGE_SIZE;
    }

    return allRows;
}

// ─── Get distinct trading dates from the table ─────────────────────────────
async function getDistinctTradingDates({ symbol, broker_id } = {}) {
    // Fetch the most recent 60 calendar days worth of distinct date values.
    // We do small pages and deduplicate on the JS side.
    const PAGE_SIZE = 1000;
    let allDates = new Set();
    let from = 0;

    while (allDates.size < 30) {  // We need at most 30 unique dates
        let q = supabase
            .from('broker_holding')
            .select('date')
            .order('date', { ascending: false })
            .range(from, from + PAGE_SIZE - 1);

        if (symbol) q = q.eq('symbol', symbol);
        if (broker_id) q = q.eq('broker_id', broker_id);

        const { data, error } = await q;
        if (error) throw new Error(`Failed to fetch dates: ${error.message}`);
        if (!data || data.length === 0) break;

        data.forEach(r => allDates.add(r.date));
        if (data.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
    }

    // Return sorted descending (most recent first)
    return [...allDates].sort((a, b) => (a > b ? -1 : 1));
}

// ─── Build the date range based on period / specific date ─────────────────
async function buildDateRange({ date: specificDate, period, symbol, broker_id }) {
    if (specificDate) {
        return { startDate: specificDate, endDate: specificDate };
    }

    if (!period) {
        throw new Error('Either date or period must be provided');
    }

    // First, find the latest available date
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
            // Fetch distinct trading dates to find exactly 7 trading days
            const uniqueDates = await getDistinctTradingDates({ symbol, broker_id });
            if (uniqueDates.length === 0) {
                throw new Error('No data found for the given filters');
            }
            // Use 7th trading day or earliest available
            startDate = uniqueDates.length >= 7 ? uniqueDates[6] : uniqueDates[uniqueDates.length - 1];
            break;
        }

        case '1M':  startDate = formatDate(addDays(maxDate, -30));  break;
        case '3M':  startDate = formatDate(addDays(maxDate, -90));  break;
        case '1Y':  startDate = formatDate(addDays(maxDate, -365)); break;
        case '2Y':  startDate = formatDate(addDays(maxDate, -730)); break;
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
        const { date, period, symbol, memberId, type, page, limit, route } = req.query;

        // ── Broker list sub-route ─────────────────────────────────────────────
        if (route === 'brokers') {
            const { data, error } = await supabaseMain
                .from('brokers')
                .select('broker_id, broker_name')
                .order('broker_id', { ascending: true });
            if (error) return res.status(500).json({ success: false, error: error.message });
            return res.status(200).json({ success: true, count: data.length, brokers: data });
        }

        if (!date && !period) {
            return res.status(400).json({ error: 'Either date or period must be provided' });
        }
        if (date && period) {
            return res.status(400).json({ error: 'Provide either date or period, not both' });
        }

        let typeFilter = null;
        if (type) {
            if (type === 'Buy') typeFilter = 'buy';
            else if (type === 'Sell') typeFilter = 'sell';
            else return res.status(400).json({ error: 'Type must be "Buy" or "Sell"' });
        }

        let broker_id = null;
        if (memberId) {
            broker_id = parseInt(memberId, 10);
            if (isNaN(broker_id)) {
                return res.status(400).json({ error: 'memberId must be a valid integer' });
            }
        }

        // ── Date range ──────────────────────────────────────────────────────
        const { startDate, endDate } = await buildDateRange({ date, period, symbol, broker_id });
        const filters = { symbol: symbol || null, broker_id };

        // ── Fetch ALL rows (auto-paginate) ───────────────────────────────────
        const allRows = await fetchAllRows(
            null,
            'date, symbol, broker_id, holding_qty, holding_amount',
            filters,
            { startDate, endDate }
        );

        // ── Summary over all rows (before type filter) ───────────────────────
        const summary = computeSummary(allRows);

        // ── Apply type filter ────────────────────────────────────────────────
        let dataRows = allRows;
        if (typeFilter === 'buy')  dataRows = allRows.filter(r => Number(r.holding_qty || 0) > 0);
        if (typeFilter === 'sell') dataRows = allRows.filter(r => Number(r.holding_qty || 0) < 0);

        // ── Map to response shape ────────────────────────────────────────────
        const mappedRows = dataRows.map(row => ({
            date:           row.date,
            symbol:         row.symbol,
            broker_id:      row.broker_id,
            buy_qty:        0,
            buy_amount:     0,
            sell_qty:       0,
            sell_amount:    0,
            holding_qty:    Number(row.holding_qty || 0),
            holding_amount: Number(row.holding_amount || 0),
        }));

        // ── Optional client-side pagination via ?page=&limit= ────────────────
        const pageNum  = parseInt(page  || '1',    10);
        const limitNum = parseInt(limit || '1000', 10);
        const safeLimit = Math.min(Math.max(limitNum, 1), 1000);
        const offset = (pageNum - 1) * safeLimit;
        const paginatedRows = mappedRows.slice(offset, offset + safeLimit);

        // ── Extra Calculations for 1M / 3M periods ───────────────────────────
        let symbolSummary = null;
        let brokerSummary = null;

        if (period === '1M' || period === '3M') {
            if (broker_id && !symbol) {
                // Group by symbol
                const groups = {};
                for (const row of allRows) {
                    const sym = row.symbol;
                    if (!groups[sym]) groups[sym] = [];
                    groups[sym].push(row);
                }
                symbolSummary = Object.entries(groups).map(([sym, rows]) => ({
                    symbol: sym,
                    ...computeSummary(rows)
                })).sort((a, b) => Math.abs(b.holdingQuantity) - Math.abs(a.holdingQuantity));
            } else if (symbol && !broker_id) {
                // Group by broker_id
                const groups = {};
                for (const row of allRows) {
                    const bId = row.broker_id;
                    if (!groups[bId]) groups[bId] = [];
                    groups[bId].push(row);
                }
                brokerSummary = Object.entries(groups).map(([bId, rows]) => ({
                    broker_id: Number(bId),
                    ...computeSummary(rows)
                })).sort((a, b) => Math.abs(b.holdingQuantity) - Math.abs(a.holdingQuantity));
            }
        }

        const response = {
            success: true,
            filters: {
                ...(date     && { date }),
                ...(period   && { period }),
                ...(symbol   && { symbol }),
                ...(broker_id !== null && { memberId: broker_id }),
                ...(type     && { type }),
                startDate,
                endDate,
            },
            summary,
            ...(symbolSummary && { symbolSummary }),
            ...(brokerSummary && { brokerSummary }),
            pagination: {
                total:      mappedRows.length,
                page:       pageNum,
                limit:      safeLimit,
                totalPages: Math.ceil(mappedRows.length / safeLimit),
            },
            data: paginatedRows,
        };

        if (allRows.length === 0) {
            response.message = 'No records found for the given filters';
        }

        return res.status(200).json(response);
    } catch (error) {
        console.error('API error:', error);
        const statusCode = error.message.includes('No data found') ? 404 : 400;
        return res.status(statusCode).json({ error: error.message });
    }
}
