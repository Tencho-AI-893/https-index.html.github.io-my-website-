/**
 * n8n Code node script: customer heat scoring + churn-risk alert extraction
 *
 * - Input: $input.all() items with json keys:
 *   user_name, visit_count, total_spent, last_visit_date (YYYY-MM-DD), average_cycle_days
 * - Output: alert-only items with message text for downstream notification nodes.
 */

const RANK_THRESHOLDS = {
  S: { minVisits: 30, minSpent: 300000 },
  A: { minVisits: 18, minSpent: 150000 },
  B: { minVisits: 8, minSpent: 60000 },
};

const ALERT_OVERDUE_DAYS = 7;
const RECOMMENDED_ACTION = 'LINEで軽く様子を聞く';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function diffDaysFromToday(dateStr) {
  if (!dateStr) return null;

  const targetDate = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(targetDate.getTime())) return null;

  const now = new Date();
  const todayUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const targetUTC = Date.UTC(
    targetDate.getUTCFullYear(),
    targetDate.getUTCMonth(),
    targetDate.getUTCDate()
  );

  return Math.floor((todayUTC - targetUTC) / MS_PER_DAY);
}

function getRank(visitCount, totalSpent) {
  if (
    visitCount >= RANK_THRESHOLDS.S.minVisits ||
    totalSpent >= RANK_THRESHOLDS.S.minSpent
  ) {
    return 'S';
  }

  if (
    visitCount >= RANK_THRESHOLDS.A.minVisits ||
    totalSpent >= RANK_THRESHOLDS.A.minSpent
  ) {
    return 'A';
  }

  if (
    visitCount >= RANK_THRESHOLDS.B.minVisits ||
    totalSpent >= RANK_THRESHOLDS.B.minSpent
  ) {
    return 'B';
  }

  return 'C';
}

function evaluateCustomer(customer) {
  const userName = customer.user_name ?? '不明顧客';
  const visitCount = safeNumber(customer.visit_count, 0);
  const totalSpent = safeNumber(customer.total_spent, 0);
  const avgCycleDays = safeNumber(customer.average_cycle_days, 0);

  const daysSinceLastVisit = diffDaysFromToday(customer.last_visit_date);
  const rank = getRank(visitCount, totalSpent);

  const isAlert =
    daysSinceLastVisit !== null &&
    avgCycleDays >= 0 &&
    daysSinceLastVisit - avgCycleDays >= ALERT_OVERDUE_DAYS;

  return {
    user_name: userName,
    rank,
    days_since_last_visit: daysSinceLastVisit,
    is_alert: isAlert,
    recommended_action: RECOMMENDED_ACTION,
    message: `【離反予兆】${userName} / ランク:${rank} / 最終来店から${daysSinceLastVisit ?? '-'}日 / 推奨:${RECOMMENDED_ACTION}`,
  };
}

function transformForN8n(inputItems) {
  return inputItems
    .map((item) => item.json ?? {})
    .map(evaluateCustomer)
    .filter((row) => row.is_alert)
    .map((row) => ({ json: row }));
}

const n8nInputItems = typeof $input !== 'undefined' && $input?.all ? $input.all() : [];
const result = transformForN8n(n8nInputItems);

// n8n Code node expected output
if (typeof $input !== 'undefined') {
  return result;
}

// Local test mode (when executed with node customer_scoring.js)
if (typeof module !== 'undefined' && require.main === module) {
  const demoItems = [
    {
      json: {
        user_name: '田中 太郎',
        visit_count: 22,
        total_spent: 189000,
        last_visit_date: '2026-02-20',
        average_cycle_days: 28,
      },
    },
    {
      json: {
        user_name: '鈴木 花子',
        visit_count: 5,
        total_spent: 32000,
        last_visit_date: '2026-03-30',
        average_cycle_days: 20,
      },
    },
  ];

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(transformForN8n(demoItems), null, 2));
}
