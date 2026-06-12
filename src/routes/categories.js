import { Router } from 'express';
import { pool } from '../db/pool.js';
import { ApiError, asyncHandler } from '../utils/errors.js';
import { optionalColor, optionalText, requireText, requireUuid } from '../utils/validation.js';

export const categoriesRouter = Router();

const selectColumns = `
  c.id,
  c.user_id AS "ownerUserId",
  owner.email AS "ownerEmail",
  c.name,
  c.color,
  c.icon,
  c.sort_order AS "sortOrder"
`;

categoriesRouter.get('/', asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT DISTINCT ${selectColumns}
     FROM categories c
     JOIN users owner ON owner.id = c.user_id
     WHERE c.user_id = $1
        OR EXISTS (
          SELECT 1
          FROM accounts a
          JOIN account_members am ON am.account_id = a.id
          WHERE a.user_id = c.user_id
            AND am.user_id = $1
        )
     ORDER BY c.sort_order, c.name`,
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
     RETURNING id, user_id AS "ownerUserId", name, color, icon, sort_order AS "sortOrder"`,
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
     RETURNING id, user_id AS "ownerUserId", name, color, icon, sort_order AS "sortOrder"`,
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
       EXISTS(SELECT 1 FROM transaction_items WHERE user_id = $1 AND category_id = $2) AS has_transactions`,
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
