import { Router } from 'express';
import { pool } from '../db/pool.js';
import { ApiError, asyncHandler } from '../utils/errors.js';
import { optionalAmount, requireAmount, requireUuid, toMonthDate } from '../utils/validation.js';

export const budgetsRouter = Router();

const listQuery = `
  SELECT
    b.id,
    b.category_id AS "categoryId",
    c.name AS category,
    to_char(b.month, 'YYYY-MM') AS month,
    b.amount::float AS amount,
    COALESCE(SUM(ti.total_price), 0)::float AS spent,
    (b.amount - COALESCE(SUM(ti.total_price), 0))::float AS remaining,
    CASE
      WHEN b.amount = 0 THEN 0
      ELSE ROUND((COALESCE(SUM(ti.total_price), 0) / b.amount * 100)::numeric, 2)::float
    END AS progress
  FROM budgets b
  JOIN categories c ON c.user_id = b.user_id AND c.id = b.category_id
  LEFT JOIN transactions t
    ON t.user_id = b.user_id
    AND date_trunc('month', t.transaction_date)::date = b.month
    AND t.deleted = false
    AND t.transaction_type = 'expense'
  LEFT JOIN transaction_items ti
    ON ti.user_id = t.user_id
    AND ti.transaction_id = t.id
    AND ti.category_id = b.category_id
  WHERE b.user_id = $1 AND b.month = $2
  GROUP BY b.id, c.id, c.name, c.sort_order
  ORDER BY c.sort_order, c.name
`;

budgetsRouter.get('/', asyncHandler(async (req, res) => {
  const month = toMonthDate(req.query.month);
  const result = await pool.query(listQuery, [req.user.id, month]);
  res.json(result.rows);
}));

budgetsRouter.post('/', asyncHandler(async (req, res) => {
  const categoryId = requireUuid(req.body.categoryId, 'categoryId');
  const month = toMonthDate(req.body.month);
  const amount = requireAmount(req.body.amount, { allowZero: true });

  const category = await pool.query('SELECT name FROM categories WHERE user_id = $1 AND id = $2', [req.user.id, categoryId]);
  if (category.rowCount === 0) {
    throw new ApiError(404, 'NOT_FOUND', 'Category not found');
  }

  const result = await pool.query(
    `WITH updated AS (
       UPDATE budgets
       SET amount = $4
       WHERE user_id = $1 AND category_id = $2 AND month = $3
       RETURNING id, category_id AS "categoryId", to_char(month, 'YYYY-MM') AS month, amount::float AS amount, false AS inserted
     ),
     inserted AS (
       INSERT INTO budgets (user_id, category_id, month, amount)
       SELECT $1, $2, $3, $4
       WHERE NOT EXISTS (SELECT 1 FROM updated)
       RETURNING id, category_id AS "categoryId", to_char(month, 'YYYY-MM') AS month, amount::float AS amount, true AS inserted
     )
     SELECT * FROM updated
     UNION ALL
     SELECT * FROM inserted`,
    [req.user.id, categoryId, month, amount]
  );

  const stored = result.rows[0];

  res.status(stored.inserted ? 201 : 200).json({
    id: stored.id,
    categoryId: stored.categoryId,
    category: category.rows[0].name,
    month: stored.month,
    amount: stored.amount
  });
}));

budgetsRouter.patch('/:id', asyncHandler(async (req, res) => {
  const id = requireUuid(req.params.id);
  const amount = optionalAmount(req.body.amount, { allowZero: true });
  if (amount === undefined) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'amount is required', { field: 'amount' });
  }

  const result = await pool.query(
    `UPDATE budgets b
     SET amount = $3
     FROM categories c
     WHERE b.user_id = $1 AND b.id = $2 AND c.user_id = b.user_id AND c.id = b.category_id
     RETURNING b.id, b.category_id AS "categoryId", c.name AS category, to_char(b.month, 'YYYY-MM') AS month, b.amount::float AS amount`,
    [req.user.id, id, amount]
  );

  if (result.rowCount === 0) {
    throw new ApiError(404, 'NOT_FOUND', 'Budget not found');
  }

  res.json(result.rows[0]);
}));

budgetsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const id = requireUuid(req.params.id);
  const result = await pool.query('DELETE FROM budgets WHERE user_id = $1 AND id = $2', [req.user.id, id]);
  if (result.rowCount === 0) {
    throw new ApiError(404, 'NOT_FOUND', 'Budget not found');
  }
  res.status(204).send();
}));
