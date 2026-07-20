// api/brokerHolding.js — self-contained (lib + utils merged in)
import { createClient } from '@supabase/supabase-js';

// ─── Supabase client (separate DB — uses SUPABASE_URL_2 / SUPABASE_ANON_KEY_2) ─
const supabaseUrl = process.env.SUPABASE_URL_2;
const supabaseKey = process.env.SUPABASE_ANON_KEY_2;
if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing SUPABASE_URL_2 or SUPABASE_ANON_KEY_2 environment variables');
}
const supabase = createClient(supabaseUrl, supabaseKey);

// ─── Date helpers ────────────────────────────────────────────────────────────
/**
 * Add or subtract days from a date.
 * @param {Date} date - The starting date.
 * @param {number} days - Number of days to add (positive) or subtract (negative).
 * @returns {Date} New date.
 */
function addDays(date, days) {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
}

/** Format a Date object to YYYY-MM-DD. */
function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// ─── Calculations (merged from utils/calculations.js) ─────────────────────────
/**
 * Compute summary statistics from an array of transaction rows.
 * @param {Array} rows - Array of objects with buy_qty, buy_amount, sell_qty, sell_amount.
 * @returns {Object} Summary with buy/sell quantities, amounts, averages, and holding.
 */
function computeSummary(rows) {
    let totalBuyQty = 0, totalSellQty = 0;
    let totalBuyAmount = 0, totalSellAmount = 0;

    for (const row of rows) {
        totalBuyQty += Number(row.buy_qty);
        totalSellQty += Number(row.sell_qty);
        totalBuyAmount += Number(row.buy_amount);
        totalSellAmount += Number(row.sell_amount);
    }

    const holdingQty = totalBuyQty - totalSellQty;
    const netAmount = totalBuyAmount - totalSellAmount;

    const avgBuyPrice = totalBuyQty > 0 ? totalBuyAmount / totalBuyQty : 0;
    const avgSellPrice = totalSellQty > 0 ? totalSellAmount / totalSellQty : 0;

    return {
        buyQuantity: totalBuyQty,
        sellQuantity: totalSellQty,
        holdingQuantity: holdingQty,
        buyAmount: totalBuyAmount,
        sellAmount: totalSellAmount,
        netAmount: netAmount,
        averageBuyPrice: avgBuyPrice,
        averageSellPrice: avgSellPrice,
    };
}

// ─── Query builder (merged from utils/queryBuilder.js) ────────────────────────
/**
 * Build the date range (startDate, endDate) based on request parameters.
 * For '1D' / '1W' uses actual trading days; other periods use calendar days.
 */
async function buildDateRange({ date: specificDate, period, symbol, broker_id }) {
    if (specificDate) {
        return { startDate: specificDate, endDate: specificDate };
    }

    if (!period) {
        throw new Error('Either date or period must be provided');
    }

    let query = supabase
        .from('broker_holding')
        .select('date')
        .order('date', { ascending: false })
        .limit(1);

    if (symbol) query = query.eq('symbol', symbol);
    if (broker_id) query = query.eq('broker_id', broker_id);

    const { data: maxDateResult, error: maxError } = await query;
    if (maxError) throw new Error(`Failed to fetch max date: ${maxError.message}`);
    if (!maxDateResult || maxDateResult.length === 0) {
        throw new Error('No data found for the given filters');
    }

    const maxDate = new Date(maxDateResult[0].date + 'T00:00:00Z');
    const endDate = formatDate(maxDate);
    let startDate;

    switch (period) {
        case '1D':
            startDate = endDate;
            break;
        case '1W': {
            let distinctQuery = supabase
                .from('broker_holding')
                .select('date')
                .order('date', { ascending: false })
                .limit(1)
                .range(6, 6);
            if (symbol) distinctQuery = distinctQuery.eq('symbol', symbol);
            if (broker_id) distinctQuery = distinctQuery.eq('broker_id', broker_id);
            const { data: seventh, error: seventhError } = await distinctQuery;
            if (seventhError) throw new Error(`Failed to get 7th trading day: ${seventhError.message}`);
            if (!seventh || seventh.length === 0) {
                const { data: earliest, error: earliestError } = await supabase
                    .from('broker_holding')
                    .select('date')
                    .order('date', { ascending: true })
                    .limit(1)
                    .eq('symbol', symbol || '')
                    .eq('broker_id', broker_id || 0);
                if (earliestError) throw new Error(`Failed to get earliest date: ${earliestError.message}`);
                if (!earliest || earliest.length === 0) throw new Error('No data found');
                startDate = earliest[0].date;
            } else {
                startDate = seventh[0].date;
            }
            break;
        }
        case '1M': startDate = formatDate(addDays(maxDate, -30)); break;
        case '3M': startDate = formatDate(addDays(maxDate, -90)); break;
        case '1Y': startDate = formatDate(addDays(maxDate, -365)); break;
        case '2Y': startDate = formatDate(addDays(maxDate, -730)); break;
        default: throw new Error(`Invalid period: ${period}`);
    }

    return { startDate, endDate };
}

function buildFilters({ symbol, broker_id }) {
    const filters = {};
    if (symbol) filters.symbol = symbol;
    if (broker_id) filters.broker_id = broker_id;
    return filters;
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
        const { date, period, symbol, memberId, type } = req.query;

        if (!date && !period) {
            return res.status(400).json({ error: 'Either date or period must be provided' });
        }
        if (date && period) {
            return res.status(400).json({ error: 'Provide either date or period, not both' });
        }

        // Type mapping: 'Buy' -> filter rows with buy_qty > 0, 'Sell' -> sell_qty > 0
        let typeFilter = null;
        if (type) {
            if (type === 'Buy') typeFilter = 'buy';
            else if (type === 'Sell') typeFilter = 'sell';
            else {
                return res.status(400).json({ error: 'Type must be "Buy" or "Sell"' });
            }
        }

        let broker_id = null;
        if (memberId) {
            broker_id = parseInt(memberId, 10);
            if (isNaN(broker_id)) {
                return res.status(400).json({ error: 'memberId must be a valid integer' });
            }
        }

        // Get date range
        const dateRange = await buildDateRange({ date, period, symbol, broker_id });
        const { startDate, endDate } = dateRange;

        // Build filters
        const filters = buildFilters({ symbol, broker_id });
        let query = supabase
            .from('broker_holding')
            .select('date, symbol, broker_id, buy_qty, buy_amount, sell_qty, sell_amount')
            .gte('date', startDate)
            .lte('date', endDate);

        if (filters.symbol) query = query.eq('symbol', filters.symbol);
        if (filters.broker_id) query = query.eq('broker_id', filters.broker_id);

        const { data: rows, error: queryError } = await query;
        if (queryError) {
            console.error('Supabase query error:', queryError);
            return res.status(500).json({ error: 'Database query failed' });
        }

        // Compute summary from all rows
        const summary = computeSummary(rows);

        // Filter data rows if type is provided
        let dataRows = rows;
        if (typeFilter === 'buy') {
            dataRows = rows.filter(row => Number(row.buy_qty) > 0);
        } else if (typeFilter === 'sell') {
            dataRows = rows.filter(row => Number(row.sell_qty) > 0);
        }

        const response = {
            success: true,
            filters: {
                ...(date && { date }),
                ...(period && { period }),
                ...(symbol && { symbol }),
                ...(broker_id !== null && { memberId: broker_id }),
                ...(type && { type }),
                startDate,
                endDate,
            },
            summary,
            data: dataRows.map(row => ({
                date: row.date,
                symbol: row.symbol,
                broker_id: row.broker_id,
                buy_qty: Number(row.buy_qty),
                buy_amount: Number(row.buy_amount),
                sell_qty: Number(row.sell_qty),
                sell_amount: Number(row.sell_amount),
                holding_qty: Number(row.buy_qty) - Number(row.sell_qty),
                holding_amount: Number(row.buy_amount) - Number(row.sell_amount),
            })),
        };

        if (rows.length === 0) {
            response.message = 'No records found for the given filters';
        }

        return res.status(200).json(response);
    } catch (error) {
        console.error('API error:', error);
        const statusCode = error.message.includes('No data found') ? 404 : 400;
        return res.status(statusCode).json({ error: error.message });
    }
}
