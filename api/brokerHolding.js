// api/brokerHolding.js — self-contained (lib + utils merged in)
const { createClient } = require('@supabase/supabase-js');

// ─── Supabase client (separate DB — uses SUPABASE_URL_2 / SUPABASE_ANON_KEY_2) ─
const supabaseUrl = process.env.SUPABASE_URL_2;
const supabaseKey = process.env.SUPABASE_ANON_KEY_2;
if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing SUPABASE_URL_2 or SUPABASE_ANON_KEY_2 environment variables');
}
const supabase = createClient(supabaseUrl, supabaseKey);

// ─── Date helpers (merged from utils/dateHelpers.js) ──────────────────────────
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
 * @param {Array} rows - Array of objects with type, totalQuantity, totalAmount.
 * @returns {Object} Summary with buy/sell quantities, amounts, averages, and holding.
 */
function computeSummary(rows) {
    let buyQuantity = 0, sellQuantity = 0;
    let buyAmount = 0, sellAmount = 0;

    for (const row of rows) {
        const qty = Number(row.totalQuantity);
        const amt = Number(row.totalAmount);
        if (row.type === 'Buyer') {
            buyQuantity += qty;
            buyAmount += amt;
        } else if (row.type === 'Seller') {
            sellQuantity += qty;
            sellAmount += amt;
        }
    }

    const holdingQuantity = buyQuantity - sellQuantity;
    const netAmount = buyAmount - sellAmount;
    const averageBuyPrice  = buyQuantity  > 0 ? buyAmount  / buyQuantity  : 0;
    const averageSellPrice = sellQuantity > 0 ? sellAmount / sellQuantity : 0;

    return {
        buyQuantity,
        sellQuantity,
        holdingQuantity,
        buyAmount,
        sellAmount,
        netAmount,
        averageBuyPrice,
        averageSellPrice,
    };
}

// ─── Query builder (merged from utils/queryBuilder.js) ────────────────────────
/**
 * Build the date range (startDate, endDate) based on request parameters.
 * For '1D' / '1W' uses actual trading days; other periods use calendar days.
 */
async function buildDateRange({ date: specificDate, period, symbol, memberId }) {
    if (specificDate) {
        return { startDate: specificDate, endDate: specificDate };
    }

    if (!period) {
        throw new Error('Either date or period must be provided');
    }

    // Get the latest date from the database, with optional filters.
    let maxQuery = supabase
        .from('broker_holding')
        .select('date')
        .order('date', { ascending: false })
        .limit(1);

    if (symbol)   maxQuery = maxQuery.eq('symbol', symbol);
    if (memberId) maxQuery = maxQuery.eq('memberId', memberId);

    const { data: maxDateResult, error: maxError } = await maxQuery;
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
            // 7th latest distinct trading date (0-indexed offset = 6).
            let weekQuery = supabase
                .from('broker_holding')
                .select('date')
                .order('date', { ascending: false })
                .limit(1)
                .range(6, 6);

            if (symbol)   weekQuery = weekQuery.eq('symbol', symbol);
            if (memberId) weekQuery = weekQuery.eq('memberId', memberId);

            const { data: seventhDateResult, error: seventhError } = await weekQuery;
            if (seventhError) throw new Error(`Failed to get 7th trading day: ${seventhError.message}`);

            if (!seventhDateResult || seventhDateResult.length === 0) {
                // Fewer than 7 trading days — fall back to earliest available.
                let earliestQuery = supabase
                    .from('broker_holding')
                    .select('date')
                    .order('date', { ascending: true })
                    .limit(1);
                if (symbol)   earliestQuery = earliestQuery.eq('symbol', symbol);
                if (memberId) earliestQuery = earliestQuery.eq('memberId', memberId);

                const { data: earliest, error: earliestError } = await earliestQuery;
                if (earliestError) throw new Error(`Failed to get earliest date: ${earliestError.message}`);
                if (!earliest || earliest.length === 0) throw new Error('No data found');
                startDate = earliest[0].date;
            } else {
                startDate = seventhDateResult[0].date;
            }
            break;
        }

        case '1M':  startDate = formatDate(addDays(maxDate,  -30));  break;
        case '3M':  startDate = formatDate(addDays(maxDate,  -90));  break;
        case '1Y':  startDate = formatDate(addDays(maxDate, -365));  break;
        case '2Y':  startDate = formatDate(addDays(maxDate, -730));  break;
        default:
            throw new Error(`Invalid period: "${period}". Valid values: 1D, 1W, 1M, 3M, 1Y, 2Y`);
    }

    return { startDate, endDate };
}

/**
 * Build the Supabase filter object for the main data fetch.
 * Note: type is filtered in JavaScript after the query, not in SQL.
 */
function buildFilters({ symbol, memberId }) {
    const filters = {};
    if (symbol)   filters.symbol   = symbol;
    if (memberId) filters.memberId = memberId;
    return filters;
}

// ─── Main handler ─────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        // 1. Parse query parameters.
        const { date, period, symbol, memberId, type } = req.query;

        // Validate period / date mutual exclusivity.
        if (!date && !period) {
            return res.status(400).json({ error: 'Either date or period must be provided' });
        }
        if (date && period) {
            return res.status(400).json({ error: 'Provide either date or period, not both' });
        }

        // Validate type: frontend sends 'Buy' or 'Sell'.
        let typeFilter = null;
        if (type) {
            if      (type === 'Buy')  typeFilter = 'Buyer';
            else if (type === 'Sell') typeFilter = 'Seller';
            else return res.status(400).json({ error: 'type must be "Buy" or "Sell"' });
        }

        // Convert memberId to integer.
        let memberIdInt = null;
        if (memberId) {
            memberIdInt = parseInt(memberId, 10);
            if (isNaN(memberIdInt)) {
                return res.status(400).json({ error: 'memberId must be a valid integer' });
            }
        }

        // 2. Determine date range.
        const { startDate, endDate } = await buildDateRange({
            date, period, symbol, memberId: memberIdInt
        });

        // 3. Build and execute the main query.
        const filters = buildFilters({ symbol, memberId: memberIdInt });
        let query = supabase
            .from('broker_holding')
            .select('date, symbol, memberId, type, totalQuantity, totalAmount, averagePrice')
            .gte('date', startDate)
            .lte('date', endDate);

        if (filters.symbol)   query = query.eq('symbol',   filters.symbol);
        if (filters.memberId) query = query.eq('memberId', filters.memberId);

        const { data: rows, error: queryError } = await query;
        if (queryError) {
            console.error('Supabase query error:', queryError);
            return res.status(500).json({ error: 'Database query failed' });
        }

        // 4. Compute summary from all rows (before optional type filter).
        const summary = computeSummary(rows);

        // 5. Apply optional type filter to response rows.
        const dataRows = typeFilter ? rows.filter(r => r.type === typeFilter) : rows;

        // 6. Build response.
        const response = {
            success: true,
            filters: {
                ...(date       && { date }),
                ...(period     && { period }),
                ...(symbol     && { symbol }),
                ...(memberIdInt !== null && { memberId: memberIdInt }),
                ...(type       && { type }),
                startDate,
                endDate,
            },
            summary,
            data: dataRows.map(row => ({
                date:          row.date,
                symbol:        row.symbol,
                memberId:      row.memberId,
                type:          row.type,
                totalQuantity: Number(row.totalQuantity),
                totalAmount:   Number(row.totalAmount),
                averagePrice:  Number(row.averagePrice),
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
};
