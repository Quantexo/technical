// api/brokerHolding.js — fully optimized (aggregates, no count, fast pagination)
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
            // fetch at most 30 distinct dates (very fast with indexes)
            const { data: dates } = await supabase
                .from('broker_holding')
                .select('date')
                .order('date', { ascending: false })
                .limit(30);
            const uniqueDates = [...new Set(dates.map(d => d.date))].sort((a, b) => (a > b ? -1 : 1));
            if (uniqueDates.length === 0) throw new Error('No data found for the given filters');
            startDate = uniqueDates.length >= 7 ? uniqueDates[6] : uniqueDates[uniqueDates.length - 1];
            break;
        }

        case '1M':  startDate = formatDate(addDays(maxDate, -30));  break;
        case '3M':  startDate = formatDate(addDays(maxDate, -90));  break;
        case '6M':  startDate = formatDate(addDays(maxDate, -180)); break;
        case '9M':  startDate = formatDate(addDays(maxDate, -270)); break;
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

        // ── Broker list sub‑route ─────────────────────────────────────────────
        if (route === 'brokers') {
            const { data, error } = await supabaseMain
                .from('brokers')
                .select('broker_id, broker_name')
                .order('broker_id', { ascending: true });
            if (error) return res.status(500).json({ success: false, error: error.message });
            return res.status(200).json({ success: true, count: data.length, brokers: data });
        }

        // ── Determine data type (route) ──────────────────────────────────────
        let dataType = 'holding';
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

        // ── Date range ──────────────────────────────────────────────────────
        const { startDate, endDate } = await buildDateRange({ date, period, symbol, broker_id });

        // ── Pagination ─────────────────────────────────────────────────────
        const pageNum  = parseInt(page  || '1',    10);
        const limitNum = parseInt(limit || '50', 10);   // default 50
        const safeLimit = Math.min(Math.max(limitNum, 1), 1000);
        const offset = (pageNum - 1) * safeLimit;

        // ── Helper: base query without count ─────────────────────────────────
        function baseQuery(selectStr) {
            let q = supabase
                .from('broker_holding')
                .select(selectStr)                     // no count
                .gte('date', startDate)
                .lte('date', endDate);

            if (symbol) q = q.eq('symbol', symbol);
            if (broker_id) q = q.eq('broker_id', broker_id);
            return q;
        }

        // ── Column names per route ──────────────────────────────────────────
        const columnMap = {
            buy:     { qty: 'buy_qty',     amt: 'buy_amount' },
            sell:    { qty: 'sell_qty',    amt: 'sell_amount' },
            holding: { qty: 'holding_qty', amt: 'holding_amount' }
        };
        const { qty: qtyCol, amt: amtCol } = columnMap[dataType];

        // ── Type filter for holding route (Buy = positive, Sell = negative) ─
        let typeFilter = null;
        if (dataType === 'holding' && type) {
            typeFilter = type === 'Buy' ? 'gt' : 'lt';   // greater than 0 or less than 0
        }

        // ════════════════════════════════════════════════════════════════
        // 1. GLOBAL SUMMARY (aggregate over all matching rows)
        // ════════════════════════════════════════════════════════════════
        let sumQuery = baseQuery(`${qtyCol}.sum(), ${amtCol}.sum()`);
        if (typeFilter) {
            sumQuery = sumQuery[typeFilter](qtyCol, 0);
        }
        const { data: sumData, error: sumError } = await sumQuery;
        if (sumError) throw new Error(`Summary query failed: ${sumError.message}`);
        const sums = sumData[0] || {};

        let summary;
        if (dataType === 'buy') {
            const totalBuyQty = Number(sums.buy_qty || 0);
            const totalBuyAmount = Number(sums.buy_amount || 0);
            summary = {
                totalBuyQty: Number(totalBuyQty.toFixed(4)),
                totalBuyAmount: Number(totalBuyAmount.toFixed(4)),
                averageBuyPrice: totalBuyQty ? Number((totalBuyAmount / totalBuyQty).toFixed(4)) : 0
            };
        } else if (dataType === 'sell') {
            const totalSellQty = Number(sums.sell_qty || 0);
            const totalSellAmount = Number(sums.sell_amount || 0);
            summary = {
                totalSellQty: Number(totalSellQty.toFixed(4)),
                totalSellAmount: Number(totalSellAmount.toFixed(4)),
                averageSellPrice: totalSellQty ? Number((totalSellAmount / totalSellQty).toFixed(4)) : 0
            };
        } else { // holding
            const holdingQty = Number(sums.holding_qty || 0);
            const holdingAmount = Number(sums.holding_amount || 0);
            summary = {
                holdingQuantity: Math.abs(holdingQty) < 1e-5 ? 0 : Number(holdingQty.toFixed(4)),
                netAmount: Math.abs(holdingAmount) < 1e-4 ? 0 : Number(holdingAmount.toFixed(4))
            };
        }

        // ════════════════════════════════════════════════════════════════
        // 2. GROUPED SUMMARIES (by symbol or broker, if applicable)
        // ════════════════════════════════════════════════════════════════
        let symbolSummary = null;
        let brokerSummary = null;

        if (broker_id && !symbol) {
            // All symbols for the given broker
            let q = supabase
                .from('broker_holding')
                .select(`symbol, ${qtyCol}.sum(), ${amtCol}.sum()`)
                .gte('date', startDate)
                .lte('date', endDate)
                .eq('broker_id', broker_id)
                .order('symbol');
            if (typeFilter) q = q[typeFilter](qtyCol, 0);
            const { data: symData, error: symError } = await q;
            if (symError) throw new Error(`Symbol summary query failed: ${symError.message}`);
            symbolSummary = (symData || []).map(r => ({
                symbol: r.symbol,
                ...(dataType === 'buy' ? {
                    totalBuyQty: Number((r.buy_qty || 0).toFixed(4)),
                    totalBuyAmount: Number((r.buy_amount || 0).toFixed(4)),
                    averageBuyPrice: r.buy_qty ? Number((r.buy_amount / r.buy_qty).toFixed(4)) : 0
                } : dataType === 'sell' ? {
                    totalSellQty: Number((r.sell_qty || 0).toFixed(4)),
                    totalSellAmount: Number((r.sell_amount || 0).toFixed(4)),
                    averageSellPrice: r.sell_qty ? Number((r.sell_amount / r.sell_qty).toFixed(4)) : 0
                } : {
                    holdingQuantity: Number((r.holding_qty || 0).toFixed(4)),
                    netAmount: Number((r.holding_amount || 0).toFixed(4))
                })
            })).sort((a, b) => {
                const aVal = a[Object.keys(a)[1]];
                const bVal = b[Object.keys(b)[1]];
                return Math.abs(bVal) - Math.abs(aVal);
            });
        } else if (symbol && !broker_id) {
            // All brokers for the given symbol
            let q = supabase
                .from('broker_holding')
                .select(`broker_id, ${qtyCol}.sum(), ${amtCol}.sum()`)
                .gte('date', startDate)
                .lte('date', endDate)
                .eq('symbol', symbol)
                .order('broker_id');
            if (typeFilter) q = q[typeFilter](qtyCol, 0);
            const { data: brkData, error: brkError } = await q;
            if (brkError) throw new Error(`Broker summary query failed: ${brkError.message}`);
            brokerSummary = (brkData || []).map(r => ({
                broker_id: r.broker_id,
                ...(dataType === 'buy' ? {
                    totalBuyQty: Number((r.buy_qty || 0).toFixed(4)),
                    totalBuyAmount: Number((r.buy_amount || 0).toFixed(4)),
                    averageBuyPrice: r.buy_qty ? Number((r.buy_amount / r.buy_qty).toFixed(4)) : 0
                } : dataType === 'sell' ? {
                    totalSellQty: Number((r.sell_qty || 0).toFixed(4)),
                    totalSellAmount: Number((r.sell_amount || 0).toFixed(4)),
                    averageSellPrice: r.sell_qty ? Number((r.sell_amount / r.sell_qty).toFixed(4)) : 0
                } : {
                    holdingQuantity: Number((r.holding_qty || 0).toFixed(4)),
                    netAmount: Number((r.holding_amount || 0).toFixed(4))
                })
            })).sort((a, b) => {
                const aVal = a[Object.keys(a)[1]];
                const bVal = b[Object.keys(b)[1]];
                return Math.abs(bVal) - Math.abs(aVal);
            });
        }

        // ════════════════════════════════════════════════════════════════
        // 3. PAGINATED DATA ROWS (fast, no exact count)
        // ════════════════════════════════════════════════════════════════
        const selectFields = 'date, symbol, broker_id, ' +
            (dataType === 'buy' ? 'buy_qty, buy_amount' :
             dataType === 'sell' ? 'sell_qty, sell_amount' :
             'holding_qty, holding_amount');

        // Fetch one extra row to detect next page
        let dataQuery = baseQuery(selectFields)
            .order('date', { ascending: false })
            .range(offset, offset + safeLimit);   // requests limit+1 rows

        if (typeFilter) {
            dataQuery = dataQuery[typeFilter](qtyCol, 0);
        }

        const { data: rawRows, error: dataError } = await dataQuery;
        if (dataError) throw new Error(`Data query failed: ${dataError.message}`);

        const hasMore = rawRows.length > safeLimit;
        const pageRows = rawRows.slice(0, safeLimit);

        // Map to response shape
        let mappedRows = (pageRows || []).map(row => {
            const obj = {
                date: row.date,
                symbol: row.symbol,
                broker_id: row.broker_id
            };
            if (dataType === 'buy') {
                obj.buy_qty = Number(row.buy_qty || 0);
                obj.buy_amount = Number(row.buy_amount || 0);
            } else if (dataType === 'sell') {
                obj.sell_qty = Number(row.sell_qty || 0);
                obj.sell_amount = Number(row.sell_amount || 0);
            } else {
                obj.holding_qty = Number(row.holding_qty || 0);
                obj.holding_amount = Number(row.holding_amount || 0);
            }
            return obj;
        });

        // Apply field selection if requested
        if (fields) {
            const allowedKeys = Object.keys(mappedRows[0] || {});
            const selected = fields.split(',').map(f => f.trim()).filter(f => allowedKeys.includes(f));
            if (selected.length) {
                mappedRows = mappedRows.map(row => {
                    const newRow = {};
                    selected.forEach(k => newRow[k] = row[k]);
                    return newRow;
                });
            }
        }

        // In-memory sorting (only if requested; dataset is max 1000 so fine)
        const sortableColumns = ['symbol', 'broker_id',
            dataType === 'buy' ? 'buy_qty' : dataType === 'sell' ? 'sell_qty' : 'holding_qty',
            dataType === 'buy' ? 'buy_amount' : dataType === 'sell' ? 'sell_amount' : 'holding_amount'
        ];
        if (sort_by && sortableColumns.includes(sort_by)) {
            const dir = sort_order === 'desc' ? -1 : 1;
            mappedRows.sort((a, b) => {
                const aVal = a[sort_by];
                const bVal = b[sort_by];
                if (aVal < bVal) return -1 * dir;
                if (aVal > bVal) return 1 * dir;
                return 0;
            });
        }

        // ── Response ─────────────────────────────────────────────────────────
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
            ...(symbolSummary && { symbolSummary }),
            ...(brokerSummary && { brokerSummary }),
            pagination: {
                page:    pageNum,
                limit:   safeLimit,
                hasNext: hasMore,
                hasPrev: pageNum > 1,
            },
            data: mappedRows,
        };

        if (mappedRows.length === 0) {
            response.message = 'No records found for the given filters';
        }

        return res.status(200).json(response);
    } catch (error) {
        console.error('API error:', error);
        const statusCode = error.message.includes('No data found') ? 404 : 400;
        return res.status(statusCode).json({ error: error.message });
    }
}