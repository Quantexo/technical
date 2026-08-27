// api/brokerHolding.js — self-contained (PostgreSQL RPC + PostgREST fallback)
import { createClient } from '@supabase/supabase-js';

// ─── Supabase client — Broker Holdings DB (DB 2) ─
const supabaseUrl2 = process.env.SUPABASE_URL_2 || process.env.SUPABASE_URL;
const supabaseKey2 = process.env.SUPABASE_SERVICE_ROLE_KEY_2 || process.env.SUPABASE_ANON_KEY_2 || process.env.SUPABASE_KEY_2 || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;

const supabase = (supabaseUrl2 && supabaseKey2) ? createClient(supabaseUrl2, supabaseKey2) : null;

// ─── Supabase client — Main DB (for brokers list & general tables) ─
const supabaseMainUrl = process.env.SUPABASE_URL || process.env.SUPABASE_URL_2;
const supabaseMainKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY_2 || process.env.SUPABASE_ANON_KEY_2 || process.env.SUPABASE_KEY_2;

const supabaseMain = (supabaseMainUrl && supabaseMainKey) ? createClient(supabaseMainUrl, supabaseMainKey) : supabase;

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

function getThreeMonthsAgo() {
    const date = new Date();
    date.setMonth(date.getMonth() - 3);
    return formatDate(date);
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
    } catch (_) { }

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

        case '1M': startDate = formatDate(addDays(maxDate, -30)); break;
        case '3M': startDate = formatDate(addDays(maxDate, -90)); break;
        case '6M': startDate = formatDate(addDays(maxDate, -180)); break;
        default: throw new Error(`Invalid period: ${period}`);
    }

    return { startDate, endDate };
}

// ─── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
    const origin = req.headers.origin;
    if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
    } else {
        res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');
    res.setHeader('Vary', 'Origin');
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

        // ── Broker Summary (Daily Turnover) sub-route ──────────────────────────────
        if (route === 'broker-summary') {
            const { broker_id, memberId, start_date, end_date, date, trading_date, limit, page, sort_by, sort_order } = req.query;

            try {
                const clients = [supabase, supabaseMain].filter(Boolean);
                if (clients.length === 0) {
                    return res.status(500).json({ success: false, error: 'Database client not initialized' });
                }

                // ─── Step 1: Detect which client contains broker_daily_summary and find latest date ─
                let activeClient = null;
                let latestDate = date || trading_date || end_date;

                for (const client of clients) {
                    try {
                        const { data, error } = await client
                            .from('broker_daily_summary')
                            .select('trading_date')
                            .order('trading_date', { ascending: false })
                            .limit(1);

                        if (!error && data && data.length > 0) {
                            activeClient = client;
                            if (!latestDate) {
                                latestDate = data[0].trading_date;
                            }
                            break;
                        }
                    } catch (_) {}
                }

                if (!activeClient) {
                    activeClient = clients[0];
                }

                // ─── Step 2: Build date range ─────────────────────────────────────────
                const targetSingleDate = date || trading_date;
                const startDate = targetSingleDate || start_date || latestDate;
                const endDate = targetSingleDate || end_date || latestDate;

                const pageNum = parseInt(page || '1', 10);
                const limitNum = parseInt(limit || '100', 10);
                const safeLimit = Math.min(Math.max(limitNum, 1), 500);
                const offset = (pageNum - 1) * safeLimit;
                const brokerIdParam = broker_id || memberId;
                const sortByCol = ['total_turnover', 'total_buy', 'total_sell', 'total_matching', 'broker_id', 'trading_date'].includes(sort_by)
                    ? sort_by
                    : 'total_turnover';
                const isAsc = sort_order === 'asc';

                // ─── Step 3: Query rows across clients ───────────────────────────────
                let data = null;
                let count = null;
                let queryError = null;

                for (const client of [activeClient, ...clients.filter(c => c !== activeClient)]) {
                    try {
                        let query = client
                            .from('broker_daily_summary')
                            .select('*', { count: 'exact' });

                        if (startDate) query = query.gte('trading_date', startDate);
                        if (endDate) query = query.lte('trading_date', endDate);

                        if (brokerIdParam) {
                            const bId = parseInt(brokerIdParam, 10);
                            if (!isNaN(bId)) {
                                query = query.eq('broker_id', bId);
                            }
                        }

                        const res = await query
                            .order(sortByCol, { ascending: isAsc })
                            .range(offset, offset + safeLimit - 1);

                        if (!res.error && res.data) {
                            data = res.data;
                            count = res.count;
                            queryError = null;
                            if (data.length > 0) break;
                        } else if (res.error) {
                            queryError = res.error;
                        }
                    } catch (err) {
                        queryError = err;
                    }
                }

                if (queryError && (!data || data.length === 0)) {
                    console.error('[Broker Summary] Query error:', queryError);
                    return res.status(500).json({
                        success: false,
                        error: queryError.message || 'Query execution failed'
                    });
                }

                // ─── Step 4: Map broker names from brokers table if available ──────────
                let brokerNameMap = {};
                try {
                    const brokerClient = supabaseMain || supabase;
                    if (brokerClient) {
                        const { data: bList } = await brokerClient
                            .from('brokers')
                            .select('broker_id, broker_name');
                        if (bList && bList.length > 0) {
                            bList.forEach(b => {
                                brokerNameMap[b.broker_id] = b.broker_name;
                            });
                        }
                    }
                } catch (_) {}

                // ─── Step 5: Format response ──────────────────────────────────────────
                const rows = data || [];
                const totalRecords = count !== null && count !== undefined ? count : rows.length;

                const formattedData = rows.map(row => ({
                    broker_id: row.broker_id,
                    broker_name: brokerNameMap[row.broker_id] || `Broker ${row.broker_id}`,
                    total_buy: Number(row.total_buy || 0),
                    total_sell: Number(row.total_sell || 0),
                    total_matching: Number(row.total_matching || 0),
                    total_turnover: Number(row.total_turnover || 0),
                    trading_date: row.trading_date
                }));

                return res.status(200).json({
                    success: true,
                    filters: {
                        broker_id: brokerIdParam || 'all',
                        trading_date: latestDate || startDate || 'all',
                        start_date: startDate,
                        end_date: endDate,
                        period: startDate === endDate ? '1 day' : `${startDate} to ${endDate}`
                    },
                    pagination: {
                        total: totalRecords,
                        page: pageNum,
                        limit: safeLimit,
                        totalPages: Math.ceil(totalRecords / safeLimit) || (rows.length > 0 ? 1 : 0)
                    },
                    data: formattedData
                });

            } catch (error) {
                console.error('[Broker Summary] Error:', error);
                return res.status(500).json({
                    success: false,
                    error: error.message,
                    stack: error.stack
                });
            }
        }

        // ── Determine data type (route) ──────────────────────────────────────
        let dataType = 'holding';    // default
        if (route === 'buy') dataType = 'buy';
        if (route === 'sell') dataType = 'sell';
        if (route && !['buy', 'sell', 'brokers', 'broker-summary'].includes(route)) {
            return res.status(400).json({ error: 'Invalid route. Use buy, sell, broker-summary, or holding (default)' });
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

        const pageNum = parseInt(page || '1', 10);
        const limitNum = parseInt(limit || '500', 10);
        const safeLimit = Math.min(Math.max(limitNum, 1), 1000);
        const offset = (pageNum - 1) * safeLimit;

        // ── Try PostgreSQL RPC Function (Server-side 50ms aggregation) ──────
        // Default sort: desc for holding (show largest positive holdings first),
        //               desc for buy/sell (show largest quantities first)
        const defaultSortOrder = 'desc';
        const { data: rpcData, error: rpcError } = await supabase.rpc('get_broker_holding_data', {
            p_start_date: startDate,
            p_end_date: endDate,
            p_symbol: symbol || null,
            p_broker_id: broker_id,
            p_route: dataType,
            p_type: type || null,
            p_sort_by: sort_by || null,
            p_sort_order: sort_order || defaultSortOrder,
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

            const isMultiDay = startDate !== endDate;

            // Always fetch raw rows — PostgREST does NOT support aggregate functions
            const selectStr = dataType === 'buy' ? 'date, symbol, broker_id, buy_qty, buy_amount' :
                dataType === 'sell' ? 'date, symbol, broker_id, sell_qty, sell_amount' :
                    'date, symbol, broker_id, holding_qty, holding_amount';

            // For multi-day ranges, fetch up to 5000 raw rows then aggregate in JS
            const fetchLimit = isMultiDay ? 5000 : safeLimit;
            const fetchOffset = isMultiDay ? 0 : offset;

            let query = supabase
                .from('broker_holding')
                .select(selectStr, { count: 'exact' })
                .gte('date', startDate)
                .lte('date', endDate)
                .range(fetchOffset, fetchOffset + fetchLimit - 1);

            if (symbol) query = query.eq('symbol', symbol);
            if (broker_id) query = query.eq('broker_id', broker_id);
            if (dataType === 'holding' && type === 'Buy') query = query.gt('holding_qty', 0);
            if (dataType === 'holding' && type === 'Sell') query = query.lt('holding_qty', 0);

            // For single-day queries, sort at DB level; for multi-day we sort after aggregation
            if (!isMultiDay) {
                const sortCol = sort_by || (dataType === 'buy' ? 'buy_qty' : dataType === 'sell' ? 'sell_qty' : 'holding_qty');
                const sortAscending = sort_order === 'asc';
                query = query.order(sortCol, { ascending: sortAscending });
            }

            const { data: fbData, count, error: fbError } = await query;
            if (fbError) throw new Error(`Database query failed: ${fbError.message}`);

            let rawRows = fbData || [];

            if (isMultiDay) {
                // ── JS-side aggregation: group by (symbol, broker_id) ──────────
                const qtyKey = dataType === 'buy' ? 'buy_qty' : dataType === 'sell' ? 'sell_qty' : 'holding_qty';
                const amountKey = dataType === 'buy' ? 'buy_amount' : dataType === 'sell' ? 'sell_amount' : 'holding_amount';

                const map = new Map();
                for (const row of rawRows) {
                    const key = `${row.symbol}|${row.broker_id}`;
                    if (!map.has(key)) {
                        map.set(key, { symbol: row.symbol, broker_id: row.broker_id, [qtyKey]: 0, [amountKey]: 0 });
                    }
                    const agg = map.get(key);
                    agg[qtyKey] += Number(row[qtyKey] || 0);
                    agg[amountKey] += Number(row[amountKey] || 0);
                }

                let aggregated = Array.from(map.values());

                // Sort the aggregated results
                const sortKey = sort_by || qtyKey;
                const sortDir = sort_order === 'asc' ? 1 : -1;   // default desc
                aggregated.sort((a, b) => sortDir * ((a[sortKey] || 0) - (b[sortKey] || 0)));

                // Re-apply type filter on net aggregated value (positive / negative)
                if (dataType === 'holding' && type === 'Buy') aggregated = aggregated.filter(r => r[qtyKey] > 0);
                if (dataType === 'holding' && type === 'Sell') aggregated = aggregated.filter(r => r[qtyKey] < 0);

                // Manual pagination on the aggregated result
                totalRecords = aggregated.length;
                rows = aggregated.slice(offset, offset + safeLimit);
            } else {
                rows = rawRows;
                totalRecords = count || rawRows.length;
            }

            summary = {
                buyQuantity: 0, sellQuantity: 0, holdingQuantity: 0,
                buyAmount: 0, sellAmount: 0, netAmount: 0,
                averageBuyPrice: 0, averageSellPrice: 0
            };
        }

        // ── Field filtering ──────────────────────────────────────────────────
        // For multi-day aggregated fallback, 'date' is not part of the response
        const isAggregatedFallback = !rpcData && startDate !== endDate;
        const fieldMap = {
            buy: isAggregatedFallback ? ['symbol', 'broker_id', 'buy_qty', 'buy_amount'] : ['date', 'symbol', 'broker_id', 'buy_qty', 'buy_amount'],
            sell: isAggregatedFallback ? ['symbol', 'broker_id', 'sell_qty', 'sell_amount'] : ['date', 'symbol', 'broker_id', 'sell_qty', 'sell_amount'],
            holding: isAggregatedFallback ? ['symbol', 'broker_id', 'holding_qty', 'holding_amount'] : ['date', 'symbol', 'broker_id', 'holding_qty', 'holding_amount'],
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
                ...(date && { date }),
                ...(period && { period }),
                ...(symbol && { symbol }),
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
                total: totalRecords,
                page: pageNum,
                limit: safeLimit,
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
