import { Router } from 'express';
import { pool } from '../db/pool.js';
import { ApiError, asyncHandler } from '../utils/errors.js';
import { optionalColor, optionalText, requireText, requireUuid } from '../utils/validation.js';

export const categoriesRouter = Router();

const selectColumns = `
  id,
  name,
  color,
  icon,
  sort_order AS "sortOrder"
`;

categoriesRouter.get('/', asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT ${selectColumns}
     FROM categories
     WHERE user_id = $1
     ORDER BY sort_order, name`,
    [req.user.id]
  );

  res.json(result.rows);
}));

categoriesRouter.post('/', asyncHandler(async (req, res) => {
  const name = requireText(req.body.name, 'name');
  const color = optionalColor(req.body.color);
  const icon = optionalText(req.body.icon, 'icon') ?? null;
  const sortOrder = Number.isInteger(req.body.sortOrder) ? req.body.sortOrder : 0;

  const result = await pool.query(
    `INSERT INTO categories (user_id, name, color, icon, sort_order)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${selectColumns}`,
    [req.user.id, name, color, icon, sortOrder]
  );

  res.status(201).json(result.rows[0]);
}));

categoriesRouter.patch('/:id', asyncHandler(async (req, res) => {
  const id = requireUuid(req.params.id);
  const updates = [];
  const values = [req.user.id, id];

  if (req.body.name !== undefined) {
    values.push(requireText(req.body.name, 'name'));
    updates.push(`name = $${values.length}`);
  }
  if (req.body.color !== undefined) {
    values.push(optionalColor(req.body.color));
    updates.push(`color = $${values.length}`);
  }
  if (req.body.icon !== undefined) {
    values.push(optionalText(req.body.icon, 'icon'));
    updates.push(`icon = $${values.length}`);
  }
  if (req.body.sortOrder !== undefined) {
    if (!Number.isInteger(req.body.sortOrder)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'sortOrder must be an integer', { field: 'sortOrder' });
    }
    values.push(req.body.sortOrder);
    updates.push(`sort_order = $${values.length}`);
  }
  if (updates.length === 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'No valid fields to update');
  }

  const result = await pool.query(
    `UPDATE categories
     SET ${updates.join(', ')}
     WHERE user_id = $1 AND id = $2
     RETURNING ${selectColumns}`,
    values
  );

  if (result.rowCount === 0) {
    throw new ApiError(404, 'NOT_FOUND', 'Category not found');
  }

  res.json(result.rows[0]);
}));

categoriesRouter.delete('/:id', asyncHandler(async (req, res) => {
  const id = requireUuid(req.params.id);
  const dependencies = await pool.query(
    `SELECT
       EXISTS(SELECT 1 FROM budgets WHERE user_id = $1 AND category_id = $2) AS has_budgets,
       EXISTS(SELECT 1 FROM transactions WHERE user_id = $1 AND category_id = $2) AS has_transactions`,
    [req.user.id, id]
  );

  if (dependencies.rows[0].has_budgets || dependencies.rows[0].has_transactions) {
    throw new ApiError(409, 'CONFLICT', 'Category has budgets or transactions');
  }

  const result = await pool.query('DELETE FROM categories WHERE user_id = $1 AND id = $2', [req.user.id, id]);
  if (result.rowCount === 0) {
    throw new ApiError(404, 'NOT_FOUND', 'Category not found');
  }

  res.status(204).send();
}));
