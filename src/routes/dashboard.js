import { Router } from 'express';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../utils/errors.js';
import { toMonthDate } from '../utils/validation.js';

export const dashboardRouter = Router();

dashboardRouter.get('/', asyncHandler(async (req, res) => {
  const monthDate = toMonthDate(req.query.month);
  const rows = await pool.query(
    `SELECT
       b.id AS "budgetId",
       c.id AS "categoryId",
       c.name AS category,
       b.amount::float AS amount,
       COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'expense'), 0)::float AS spent,
       (b.amount - COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'expense'), 0))::float AS remaining,
       CASE
         WHEN b.amount = 0 THEN 0
         ELSE ROUND((COALESCE(SUM(t.amount) FILTER (WHERE t.type = 'expense'), 0) / b.amount * 100)::numeric, 2)::float
       END AS progress
     FROM budgets b
     JOIN categories c ON c.user_id = b.user_id AND c.id = b.category_id
     LEFT JOIN transactions t
       ON t.user_id = b.user_id
       AND t.category_id = b.category_id
       AND date_trunc('month', t.transaction_date)::date = b.month
     WHERE b.user_id = $1 AND b.month = $2
     GROUP BY b.id, c.id, c.name, c.sort_order
     ORDER BY c.sort_order, c.name`,
    [req.user.id, monthDate]
  );

  const totals = rows.rows.reduce((acc, budget) => {
    acc.budgeted += budget.amount;
    acc.spent += budget.spent;
    acc.remaining += budget.remaining;
    return acc;
  }, { budgeted: 0, spent: 0, remaining: 0 });

  res.json({
    month: monthDate.slice(0, 7),
    totals: roundTotals(totals),
    budgets: rows.rows
  });
}));

function roundTotals(totals) {
  return {
    budgeted: roundMoney(totals.budgeted),
    spent: roundMoney(totals.spent),
    remaining: roundMoney(totals.remaining)
  };
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}
