import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { FREE_TIER_RENEWAL_GRACE_DAYS, FREE_TIER_RETENTION_DAYS } from '../billing/tiers.js';

const DAY_MS = 24 * 60 * 60 * 1000;
let retentionTimer = null;

export async function runFreeTierRetention({ logger = console } = {}) {
  const result = await pool.query(
    `WITH eligible_free_users AS (
       SELECT id
       FROM users
       WHERE plan_tier = 'free'
         AND (
           free_grace_started_at IS NULL
           OR free_grace_started_at < now() - ($2::int * interval '1 day')
         )
     ), deleted_transactions AS (
       DELETE FROM transactions t
       USING eligible_free_users u
       WHERE t.user_id = u.id
         AND t.transaction_date <= current_date - ($1::int * interval '1 day')
       RETURNING t.id
     ), deleted_budgets AS (
       DELETE FROM budgets b
       USING eligible_free_users u
       WHERE b.user_id = u.id
         AND b.month <= date_trunc('month', current_date - ($1::int * interval '1 day'))::date
       RETURNING b.id
     ), deleted_alerts AS (
       DELETE FROM payment_alerts pa
       USING eligible_free_users u
       WHERE pa.user_id = u.id
         AND pa.due_date <= current_date - ($1::int * interval '1 day')
       RETURNING pa.id
     )
     SELECT
       (SELECT count(*)::int FROM deleted_transactions) AS "deletedTransactions",
       (SELECT count(*)::int FROM deleted_budgets) AS "deletedBudgets",
       (SELECT count(*)::int FROM deleted_alerts) AS "deletedAlerts"`,
    [FREE_TIER_RETENTION_DAYS, FREE_TIER_RENEWAL_GRACE_DAYS]
  );

  const summary = result.rows[0] || { deletedTransactions: 0, deletedBudgets: 0, deletedAlerts: 0 };
  logger.info?.('Free tier retention completed', summary);
  return summary;
}

export function scheduleFreeTierRetention({ logger = console } = {}) {
  if (!config.freeTierRetention.enabled) {
    logger.info?.('Free tier retention job disabled');
    return () => {};
  }

  const scheduleNext = () => {
    const delay = getDelayUntilNextRun(config.freeTierRetention.runAtUtc);
    retentionTimer = setTimeout(async () => {
      try {
        await runFreeTierRetention({ logger });
      } catch (err) {
        logger.error?.('Free tier retention failed', err);
      } finally {
        scheduleNext();
      }
    }, delay);
    retentionTimer.unref?.();
  };

  scheduleNext();
  logger.info?.(`Free tier retention scheduled daily at ${config.freeTierRetention.runAtUtc} UTC`);

  return () => {
    if (retentionTimer) clearTimeout(retentionTimer);
  };
}

function getDelayUntilNextRun(runAtUtc) {
  const [hours, minutes] = String(runAtUtc || '03:20').split(':').map((part) => Number(part));
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(Number.isFinite(hours) ? hours : 3, Number.isFinite(minutes) ? minutes : 20, 0, 0);
  if (next <= now) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return Math.max(1000, next.getTime() - now.getTime());
}
