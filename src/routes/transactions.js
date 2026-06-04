import { Router } from 'express';
import { pool } from '../db/pool.js';
import { ApiError, asyncHandler } from '../utils/errors.js';
import {
  optionalAmount,
  optionalDate,
  optionalText,
  optionalType,
  requireAmount,
  requireDate,
  requireMonth,
  requireText,
  requireType,
  requireUuid
} from '../utils/validation.js';

export const transactionsRouter = Router();

const selectColumns = `
  t.id,
  to_char(t.transaction_date, 'YYYY-MM-DD') AS date,
  t.category_id AS "categoryId",
  c.name AS category,
  t.description,
  t.amount::float AS amount,
  t.type,
  t.notes
`;

transactionsRouter.get('/', asyncHandler(async (req, res) => {
  const values = [req.user.id];
  const filters = ['t.user_id = $1'];

  if (req.query.month) {
    values.push(`${requireMonth(req.query.month)}-01`);
    filters.push(`date_trunc('month', t.transaction_date)::date = $${values.length}`);
  }
  if (req.query.categoryId) {
    values.push(requireUuid(req.query.categoryId, 'categoryId'));
    filters.push(`t.category_id = $${values.length}`);
  }
  if (req.query.from) {
    values.push(optionalDate(req.query.from, 'from'));
    filters.push(`t.transaction_date >= $${values.length}`);
  }
  if (req.query.to) {
    values.push(optionalDate(req.query.to, 'to'));
    filters.push(`t.transaction_date <= $${values.length}`);
  }
  if (req.query.type) {
    values.push(requireType(req.query.type));
    filters.push(`t.type = $${values.length}`);
  }

  const result = await pool.query(
    `SELECT ${selectColumns}
     FROM transactions t
     JOIN categories c ON c.user_id = t.user_id AND c.id = t.category_id
     WHERE ${filters.join(' AND ')}
     ORDER BY t.transaction_date DESC, t.created_at DESC`,
    values
  );

  res.json(result.rows);
}));

transactionsRouter.post('/', asyncHandler(async (req, res) => {
  const date = requireDate(req.body.date);
  const categoryId = requireUuid(req.body.categoryId, 'categoryId');
  const description = requireText(req.body.description, 'description');
  const amount = requireAmount(req.body.amount);
  const type = requireType(req.body.type || 'expense');
  const notes = req.body.notes === null ? null : optionalText(req.body.notes, 'notes') ?? null;

  const result = await pool.query(
    `INSERT INTO transactions (user_id, category_id, transaction_date, description, amount, type, notes)
     SELECT $1, c.id, $3, $4, $5, $6, $7
     FROM categories c
     WHERE c.user_id = $1 AND c.id = $2
     RETURNING id`,
    [req.user.id, categoryId, date, description, amount, type, notes]
  );

  if (result.rowCount === 0) {
    throw new ApiError(404, 'NOT_FOUND', 'Category not found');
  }

  const created = await findTransaction(req.user.id, result.rows[0].id);
  res.status(201).json(created);
}));

transactionsRouter.patch('/:id', asyncHandler(async (req, res) => {
  const id = requireUuid(req.params.id);
  const updates = [];
  const values = [req.user.id, id];

  if (req.body.date !== undefined) {
    values.push(requireDate(req.body.date));
    updates.push(`transaction_date = $${values.length}`);
  }
  if (req.body.categoryId !== undefined) {
    values.push(requireUuid(req.body.categoryId, 'categoryId'));
    updates.push(`category_id = $${values.length}`);
  }
  if (req.body.description !== undefined) {
    values.push(requireText(req.body.description, 'description'));
    updates.push(`description = $${values.length}`);
  }
  if (req.body.amount !== undefined) {
    values.push(optionalAmount(req.body.amount));
    updates.push(`amount = $${values.length}`);
  }
  if (req.body.type !== undefined) {
    values.push(optionalType(req.body.type));
    updates.push(`type = $${values.length}`);
  }
  if (req.body.notes !== undefined) {
    values.push(req.body.notes === null ? null : optionalText(req.body.notes, 'notes'));
    updates.push(`notes = $${values.length}`);
  }
  if (updates.length === 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'No valid fields to update');
  }

  if (req.body.categoryId !== undefined) {
    const category = await pool.query('SELECT 1 FROM categories WHERE user_id = $1 AND id = $2', [req.user.id, req.body.categoryId]);
    if (category.rowCount === 0) {
      throw new ApiError(404, 'NOT_FOUND', 'Category not found');
    }
  }

  const result = await pool.query(
    `UPDATE transactions
     SET ${updates.join(', ')}
     WHERE user_id = $1 AND id = $2
     RETURNING id`,
    values
  );

  if (result.rowCount === 0) {
    throw new ApiError(404, 'NOT_FOUND', 'Transaction not found');
  }

  res.json(await findTransaction(req.user.id, id));
}));

transactionsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const id = requireUuid(req.params.id);
  const result = await pool.query('DELETE FROM transactions WHERE user_id = $1 AND id = $2', [req.user.id, id]);
  if (result.rowCount === 0) {
    throw new ApiError(404, 'NOT_FOUND', 'Transaction not found');
  }
  res.status(204).send();
}));

async function findTransaction(userId, id) {
  const result = await pool.query(
    `SELECT ${selectColumns}
     FROM transactions t
     JOIN categories c ON c.user_id = t.user_id AND c.id = t.category_id
     WHERE t.user_id = $1 AND t.id = $2`,
    [userId, id]
  );

  if (result.rowCount === 0) {
    throw new ApiError(404, 'NOT_FOUND', 'Transaction not found');
  }

  return result.rows[0];
}
