const HOLIDAYS = [
  '2026-05-28',
  '2026-05-29'
];

function getNPTime() {
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  return new Date(utc + (345 * 60000)); // UTC+5:45
}

function getLastTradingDay(referenceDate) {
  const checkDate = new Date(referenceDate.getTime() - 24 * 60 * 60 * 1000);
  while (true) {
    const yyyy = checkDate.getFullYear();
    const mm = String(checkDate.getMonth() + 1).padStart(2, '0');
    const dd = String(checkDate.getDate()).padStart(2, '0');
    const checkDateStr = `${yyyy}-${mm}-${dd}`;
    const day = checkDate.getDay(); // 0 is Sunday, 6 is Saturday
    const isMarketDay = (day >= 1 && day <= 5) && !HOLIDAYS.includes(checkDateStr);
    
    if (isMarketDay) {
      checkDate.setHours(15, 0, 0, 0);
      return checkDate;
    }
    checkDate.setTime(checkDate.getTime() - 24 * 60 * 60 * 1000);
  }
}

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

  try {
    const npt = getNPTime();
    const yyyy = npt.getFullYear();
    const mm = String(npt.getMonth() + 1).padStart(2, '0');
    const dd = String(npt.getDate()).padStart(2, '0');
    const currentDate = `${yyyy}-${mm}-${dd}`;
    const day = npt.getDay();
    const isMarketDay = (day >= 1 && day <= 5) && !HOLIDAYS.includes(currentDate);

    const todayStatus = isMarketDay ? 'open' : 'close';
    const currentMinutes = npt.getHours() * 60 + npt.getMinutes();

    const preOpenStart = 10 * 60 + 30;       // 10:30
    const preOpenSpecialEnd = 10 * 60 + 44; // 10:44
    const preOpenMatchingStart = 10 * 60 + 45; // 10:45
    const preOpenMatchingEnd = 10 * 60 + 59; // 10:59
    const marketOpenStart = 11 * 60;         // 11:00
    const marketOpenEnd = 15 * 60 - 1;       // 14:59

    let status = 'market close';
    let isOpenSession = false;

    if (isMarketDay) {
      if (currentMinutes < preOpenStart) {
        status = 'market close';
        isOpenSession = false;
      } else if (currentMinutes <= preOpenSpecialEnd) {
        status = 'Pre-open/Special Pre-open';
        isOpenSession = true;
      } else if (currentMinutes <= preOpenMatchingEnd) {
        status = 'Pre-open matching';
        isOpenSession = true;
      } else if (currentMinutes <= marketOpenEnd) {
        status = 'market open';
        isOpenSession = true;
      } else {
        status = 'market close';
        isOpenSession = false;
      }
    }

    let asOf;
    if (isOpenSession) {
      asOf = npt;
    } else {
      asOf = getLastTradingDay(npt);
    }

    const formattedAsOf = `${asOf.getFullYear()}-${String(asOf.getMonth() + 1).padStart(2, '0')}-${String(asOf.getDate()).padStart(2, '0')} ${String(asOf.getHours()).padStart(2, '0')}:${String(asOf.getMinutes()).padStart(2, '0')}:${String(asOf.getSeconds()).padStart(2, '0')} NPT`;

    return res.status(200).json({
      today: todayStatus,
      status: status,
      as_of: formattedAsOf
    });
  } catch (err) {
    console.error('Market status error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
}
