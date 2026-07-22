// api/brokerHolding.js — self-contained (lib + utils merged in)
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

// ─── Calculations (route‑aware) ─────────────────────────────────────────────
function computeSummary(rows, dataType) {
    if (!rows || rows.length === 0) {
        if (dataType === 'buy') return { totalBuyQty: 0, totalBuyAmount: 0, averageBuyPrice: 0 };
        if (dataType === 'sell') return { totalSellQty: 0, totalSellAmount: 0, averageSellPrice: 0 };
        // holding (default)
        return {
            buyQuantity: 0,
            sellQuantity: 0,
            holdingQuantity: 0,
            buyAmount: 0,
            sellAmount: 0,
            netAmount: 0,
            averageBuyPrice: 0,
            averageSellPrice: 0,
        };
    }

    if (dataType === 'buy') {
        const totalBuyQty = rows.reduce((sum, r) => sum + Number(r.buy_qty || 0), 0);
        const totalBuyAmount = rows.reduce((sum, r) => sum + Number(r.buy_amount || 0), 0);
        const avgBuyPrice = totalBuyQty !== 0 ? totalBuyAmount / totalBuyQty : 0;
        return {
            totalBuyQty: Number(totalBuyQty.toFixed(4)),
            totalBuyAmount: Number(totalBuyAmount.toFixed(4)),
            averageBuyPrice: Number(avgBuyPrice.toFixed(4)),
        };
    }

    if (dataType === 'sell') {
        const totalSellQty = rows.reduce((sum, r) => sum + Number(r.sell_qty || 0), 0);
        const totalSellAmount = rows.reduce((sum, r) => sum + Number(r.sell_amount || 0), 0);
        const avgSellPrice = totalSellQty !== 0 ? totalSellAmount / totalSellQty : 0;
        return {
            totalSellQty: Number(totalSellQty.toFixed(4)),
            totalSellAmount: Number(totalSellAmount.toFixed(4)),
            averageSellPrice: Number(avgSellPrice.toFixed(4)),
        };
    }

    // holding (default)
    const totalHoldingQty = rows.reduce((sum, r) => sum + Number(r.holding_qty || 0), 0);
    const totalHoldingAmount = rows.reduce((sum, r) => sum + Number(r.holding_amount || 0), 0);
    return {
        buyQuantity: 0,
        sellQuantity: 0,
        holdingQuantity: Math.abs(totalHoldingQty) < 1e-5 ? 0 : Number(totalHoldingQty.toFixed(4)),
        buyAmount: 0,
        sellAmount: 0,
        netAmount: Math.abs(totalHoldingAmount) < 1e-4 ? 0 : Number(totalHoldingAmount.toFixed(4)),
        averageBuyPrice: 0,
        averageSellPrice: 0,
    };
}

// ─── Fetch ALL rows with automatic pagination ───────────────────────────────
async function fetchAllRows(selectStr, filters, dateFilter) {
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
        if (data.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
    }

    return allRows;
}

// ─── Get distinct trading dates ─────────────────────────────────────────────
async function getDistinctTradingDates({ symbol, broker_id } = {}) {
    const PAGE_SIZE = 1000;
    let allDates = new Set();
    let from = 0;

    while (allDates.size < 30) {
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

    return [...allDates].sort((a, b) => (a > b ? -1 : 1));
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
        let dataType = 'holding';    // default
        if (route === 'buy')  dataType = 'buy';
        if (route === 'sell') dataType = 'sell';
        // Only allow known routes
        if (route && !['buy', 'sell', 'brokers'].includes(route)) {
            return res.status(400).json({ error: 'Invalid route. Use buy, sell, or holding (default)' });
        }

        if (!date && !period) {
            return res.status(400).json({ error: 'Either date or period must be provided' });
        }
        if (date && period) {
            return res.status(400).json({ error: 'Provide either date or period, not both' });
        }

        // type filter (Buy/Sell) only applies to the default holding route
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
        const filters = { symbol: symbol || null, broker_id };

        // ── Choose select string based on dataType ───────────────────────────
        let selectStr;
        if (dataType === 'buy')       selectStr = 'date, symbol, broker_id, buy_qty, buy_amount';
        else if (dataType === 'sell') selectStr = 'date, symbol, broker_id, sell_qty, sell_amount';
        else                          selectStr = 'date, symbol, broker_id, holding_qty, holding_amount';

        // ── Fetch ALL rows ───────────────────────────────────────────────────
        const allRows = await fetchAllRows(selectStr, filters, { startDate, endDate });

        // ── Summary over all rows ────────────────────────────────────────────
        const summary = computeSummary(allRows, dataType);

        // ── Group and Sum if search filters are applied ──────────────────────
        let processedRows = allRows;
        if (broker_id && !symbol) {
            // Group by symbol
            const groups = {};
            for (const row of allRows) {
                const sym = row.symbol;
                if (!groups[sym]) {
                    groups[sym] = {
                        date: '—',
                        symbol: sym,
                        broker_id: broker_id,
                        buy_qty: 0, buy_amount: 0,
                        sell_qty: 0, sell_amount: 0,
                        holding_qty: 0, holding_amount: 0
                    };
                }
                if (dataType === 'buy') {
                    groups[sym].buy_qty += Number(row.buy_qty || 0);
                    groups[sym].buy_amount += Number(row.buy_amount || 0);
                } else if (dataType === 'sell') {
                    groups[sym].sell_qty += Number(row.sell_qty || 0);
                    groups[sym].sell_amount += Number(row.sell_amount || 0);
                } else {
                    groups[sym].holding_qty += Number(row.holding_qty || 0);
                    groups[sym].holding_amount += Number(row.holding_amount || 0);
                }
            }
            processedRows = Object.values(groups);
        } else if (symbol && !broker_id) {
            // Group by broker_id
            const groups = {};
            for (const row of allRows) {
                const bId = row.broker_id;
                if (!groups[bId]) {
                    groups[bId] = {
                        date: '—',
                        symbol: symbol,
                        broker_id: bId,
                        buy_qty: 0, buy_amount: 0,
                        sell_qty: 0, sell_amount: 0,
                        holding_qty: 0, holding_amount: 0
                    };
                }
                if (dataType === 'buy') {
                    groups[bId].buy_qty += Number(row.buy_qty || 0);
                    groups[bId].buy_amount += Number(row.buy_amount || 0);
                } else if (dataType === 'sell') {
                    groups[bId].sell_qty += Number(row.sell_qty || 0);
                    groups[bId].sell_amount += Number(row.sell_amount || 0);
                } else {
                    groups[bId].holding_qty += Number(row.holding_qty || 0);
                    groups[bId].holding_amount += Number(row.holding_amount || 0);
                }
            }
            processedRows = Object.values(groups);
        }

        // ── Apply type filter only for holding route (Buy = positive, Sell = negative) ─
        if (dataType === 'holding' && type) {
            if (type === 'Buy')  processedRows = processedRows.filter(r => Number(r.holding_qty || 0) > 0);
            if (type === 'Sell') processedRows = processedRows.filter(r => Number(r.holding_qty || 0) < 0);
        }

        // ── Map rows to response shape (only relevant fields) ────────────────
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

        const mappedRows = processedRows.map(row => {
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

        // ── Optional sorting ────────────────────────────────────────────────
        const sortableColumns = dataType === 'buy'   ? ['buy_qty', 'buy_amount'] :
                                dataType === 'sell'  ? ['sell_qty', 'sell_amount'] :
                                                       ['holding_qty', 'holding_amount'];
        // Add common fields
        const allSortable = ['symbol', 'broker_id', ...sortableColumns];
        if (sort_by && allSortable.includes(sort_by)) {
            const direction = sort_order === 'desc' ? -1 : 1;
            mappedRows.sort((a, b) => {
                const aVal = a[sort_by];
                const bVal = b[sort_by];
                if (aVal < bVal) return -1 * direction;
                if (aVal > bVal) return 1 * direction;
                return 0;
            });
        }

        // ── Client‑side pagination ───────────────────────────────────────────
        const pageNum  = parseInt(page  || '1',    10);
        const limitNum = parseInt(limit || '500', 10); //CHANGE FOR LIMIT
        const safeLimit = Math.min(Math.max(limitNum, 1), 1000);
        const offset = (pageNum - 1) * safeLimit;
        const paginatedRows = mappedRows.slice(offset, offset + safeLimit);

        // ── Extra Calculations (symbol / broker summary) ─────────────────────
        let symbolSummary = null;
        let brokerSummary = null;

        if (broker_id && !symbol) {
            const groups = {};
            for (const row of allRows) {
                const sym = row.symbol;
                if (!groups[sym]) groups[sym] = [];
                groups[sym].push(row);
            }
            symbolSummary = Object.entries(groups).map(([sym, rows]) => ({
                symbol: sym,
                ...computeSummary(rows, dataType)
            })).sort((a, b) => {
                const aQty = dataType === 'buy' ? a.totalBuyQty :
                             dataType === 'sell' ? a.totalSellQty :
                             a.holdingQuantity;
                const bQty = dataType === 'buy' ? b.totalBuyQty :
                             dataType === 'sell' ? b.totalSellQty :
                             b.holdingQuantity;
                return Math.abs(bQty) - Math.abs(aQty);
            });
        } else if (symbol && !broker_id) {
            const groups = {};
            for (const row of allRows) {
                const bId = row.broker_id;
                if (!groups[bId]) groups[bId] = [];
                groups[bId].push(row);
            }
            brokerSummary = Object.entries(groups).map(([bId, rows]) => ({
                broker_id: Number(bId),
                ...computeSummary(rows, dataType)
            })).sort((a, b) => {
                const aQty = dataType === 'buy' ? a.totalBuyQty :
                             dataType === 'sell' ? a.totalSellQty :
                             a.holdingQuantity;
                const bQty = dataType === 'buy' ? b.totalBuyQty :
                             dataType === 'sell' ? b.totalSellQty :
                             b.holdingQuantity;
                return Math.abs(bQty) - Math.abs(aQty);
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
