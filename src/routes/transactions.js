import { Router } from 'express';
import { pool } from '../db/pool.js';
import { ApiError, asyncHandler } from '../utils/errors.js';
import {
  optionalDate,
  optionalText,
  requireDate,
  requireMonth,
  requireText,
  requireUuid
} from '../utils/validation.js';

export const transactionsRouter = Router();

const transactionSelect = `
  t.id,
  to_char(t.transaction_date, 'YYYY-MM-DD') AS date,
  t.paid_by AS "paidBy",
  t.paid_to AS "paidTo",
  t.ticket_code AS ticket,
  t.ticket_link AS "ticketLink",
  t.currency,
  t.total_amount::float AS amount,
  t.notes,
  to_char(t.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
  to_char(t.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
  t.deleted,
  to_char(t.deleted_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "deletedAt",
  t.created_by_user_id AS "createdByUserId",
  t.updated_by_user_id AS "updatedByUserId",
  t.deleted_by_user_id AS "deletedByUserId",
  COALESCE(
    json_agg(
      json_build_object(
        'id', ti.id,
        'categoryId', ti.category_id,
        'category', c.name,
        'item', ti.item,
        'units', ti.units::float,
        'unitPrice', ti.unit_price::float,
        'totalPrice', ti.total_price::float
      )
      ORDER BY ti.created_at, ti.id
    ) FILTER (WHERE ti.id IS NOT NULL),
    '[]'::json
  ) AS items
`;

transactionsRouter.get('/', asyncHandler(async (req, res) => {
  const values = [req.user.id];
  const filters = ['t.user_id = $1'];

  if (req.query.includeDeleted !== 'true') {
    filters.push('t.deleted = false');
  }

  if (req.query.month) {
    values.push(`${requireMonth(req.query.month)}-01`);
    filters.push(`date_trunc('month', t.transaction_date)::date = $${values.length}`);
  }
  if (req.query.categoryId) {
    values.push(requireUuid(req.query.categoryId, 'categoryId'));
    filters.push(`EXISTS (
      SELECT 1 FROM transaction_items ti_filter
      WHERE ti_filter.transaction_id = t.id AND ti_filter.category_id = $${values.length}
    )`);
  }
  if (req.query.from) {
    values.push(optionalDate(req.query.from, 'from'));
    filters.push(`t.transaction_date >= $${values.length}`);
  }
  if (req.query.to) {
    values.push(optionalDate(req.query.to, 'to'));
    filters.push(`t.transaction_date <= $${values.length}`);
  }

  const result = await pool.query(
    `SELECT ${transactionSelect}
     FROM transactions t
     LEFT JOIN transaction_items ti ON ti.user_id = t.user_id AND ti.transaction_id = t.id
     LEFT JOIN categories c ON c.user_id = ti.user_id AND c.id = ti.category_id
     WHERE ${filters.join(' AND ')}
     GROUP BY t.id
     ORDER BY t.transaction_date DESC, t.created_at DESC`,
    values
  );

  res.json(result.rows.map(withSummaryFields));
}));

transactionsRouter.post('/', asyncHandler(async (req, res) => {
  const transaction = normalizeTransaction(req.body);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await ensureCategories(client, req.user.id, transaction.items.map((item) => item.categoryId));

    const total = sumItems(transaction.items);
    const created = await client.query(
      `INSERT INTO transactions (user_id, transaction_date, paid_by, paid_to, ticket_code, ticket_link, currency, total_amount, notes, created_by_user_id, updated_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $1, $1)
       RETURNING id`,
      [
        req.user.id,
        transaction.date,
        transaction.paidBy,
        transaction.paidTo,
        transaction.ticket,
        transaction.ticketLink,
        transaction.currency,
        total,
        transaction.notes,
      ]
    );

    await insertItems(client, req.user.id, created.rows[0].id, transaction.items);
    await client.query('COMMIT');

    res.status(201).json(await findTransaction(req.user.id, created.rows[0].id));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

transactionsRouter.patch('/:id', asyncHandler(async (req, res) => {
  const id = requireUuid(req.params.id);
  const updates = [];
  const values = [req.user.id, id];
  const hasItems = req.body.items !== undefined;
  const items = hasItems ? normalizeItems(req.body.items) : null;
  const client = await pool.connect();

  if (req.body.date !== undefined) {
    values.push(requireDate(req.body.date));
    updates.push(`transaction_date = $${values.length}`);
  }
  if (req.body.paidBy !== undefined) {
    values.push(requireText(req.body.paidBy, 'paidBy'));
    updates.push(`paid_by = $${values.length}`);
  }
  if (req.body.paidTo !== undefined) {
    values.push(requireText(req.body.paidTo, 'paidTo'));
    updates.push(`paid_to = $${values.length}`);
  }
  if (req.body.ticket !== undefined) {
    values.push(optionalText(req.body.ticket, 'ticket'));
    updates.push(`ticket_code = $${values.length}`);
  }
  if (req.body.ticketLink !== undefined) {
    values.push(req.body.ticketLink ? optionalText(req.body.ticketLink, 'ticketLink') : null);
    updates.push(`ticket_link = $${values.length}`);
  }
  if (req.body.currency !== undefined) {
    values.push(requireText(req.body.currency, 'currency'));
    updates.push(`currency = $${values.length}`);
  }
  if (req.body.notes !== undefined) {
    values.push(req.body.notes ? optionalText(req.body.notes, 'notes') : null);
    updates.push(`notes = $${values.length}`);
  }
  if (hasItems) {
    values.push(sumItems(items));
    updates.push(`total_amount = $${values.length}`);
  }
  values.push(req.user.id);
  updates.push(`updated_by_user_id = $${values.length}`);
  updates.push('updated_at = now()');

  if (updates.length === 2 && !hasItems) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'No valid fields to update');
  }

  try {
    await client.query('BEGIN');

    if (hasItems) {
      await ensureCategories(client, req.user.id, items.map((item) => item.categoryId));
      await client.query('DELETE FROM transaction_items WHERE user_id = $1 AND transaction_id = $2', [req.user.id, id]);
      await insertItems(client, req.user.id, id, items);
    }

    if (updates.length > 0) {
      const result = await client.query(
        `UPDATE transactions
         SET ${updates.join(', ')}
         WHERE user_id = $1 AND id = $2 AND deleted = false
         RETURNING id`,
        values
      );

      if (result.rowCount === 0) {
        throw new ApiError(404, 'NOT_FOUND', 'Transaction not found');
      }
    }

    await client.query('COMMIT');
    res.json(await findTransaction(req.user.id, id));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

transactionsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const id = requireUuid(req.params.id);
  const result = await pool.query(
    `UPDATE transactions
     SET deleted = true,
         deleted_at = now(),
         deleted_by_user_id = $1,
         updated_by_user_id = $1,
         updated_at = now()
     WHERE user_id = $1 AND id = $2 AND deleted = false
     RETURNING id`,
    [req.user.id, id]
  );
  if (result.rowCount === 0) {
    throw new ApiError(404, 'NOT_FOUND', 'Transaction not found');
  }
  res.status(204).send();
}));

function normalizeTransaction(body) {
  return {
    date: requireDate(body.date),
    paidBy: requireText(body.paidBy, 'paidBy'),
    paidTo: requireText(body.paidTo, 'paidTo'),
    ticket: body.ticket ? optionalText(body.ticket, 'ticket') : null,
    ticketLink: body.ticketLink ? optionalText(body.ticketLink, 'ticketLink') : null,
    currency: requireText(body.currency || '$MX', 'currency'),
    notes: body.notes ? optionalText(body.notes, 'notes') : null,
    items: normalizeItems(body.items),
  };
}

function normalizeItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'items must include at least one item', { field: 'items' });
  }

  return items.map((item, index) => {
    const units = requireFiniteNumber(item.units, `items[${index}].units`);
    const unitPrice = requireFiniteNumber(item.unitPrice, `items[${index}].unitPrice`);
    const totalPrice = roundMoney(units * unitPrice);

    if (totalPrice === 0) {
      throw new ApiError(400, 'VALIDATION_ERROR', `items[${index}] total must not be zero`, { field: `items[${index}]` });
    }

    return {
      categoryId: requireUuid(item.categoryId, `items[${index}].categoryId`),
      item: requireText(item.item, `items[${index}].item`),
      units,
      unitPrice,
      totalPrice,
    };
  });
}

function requireFiniteNumber(value, field) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${field} must be a number`, { field });
  }
  return roundMoney(parsed);
}

function sumItems(items) {
  return roundMoney(items.reduce((sum, item) => sum + item.totalPrice, 0));
}

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

async function ensureCategories(client, userId, categoryIds) {
  const uniqueIds = [...new Set(categoryIds)];
  const result = await client.query(
    'SELECT id FROM categories WHERE user_id = $1 AND id = ANY($2::uuid[])',
    [userId, uniqueIds]
  );

  if (result.rowCount !== uniqueIds.length) {
    throw new ApiError(404, 'NOT_FOUND', 'One or more categories were not found');
  }
}

async function insertItems(client, userId, transactionId, items) {
  for (const item of items) {
    await client.query(
      `INSERT INTO transaction_items (user_id, transaction_id, category_id, item, units, unit_price, total_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, transactionId, item.categoryId, item.item, item.units, item.unitPrice, item.totalPrice]
    );
  }
}

async function findTransaction(userId, id) {
  const result = await pool.query(
    `SELECT ${transactionSelect}
     FROM transactions t
     LEFT JOIN transaction_items ti ON ti.user_id = t.user_id AND ti.transaction_id = t.id
     LEFT JOIN categories c ON c.user_id = ti.user_id AND c.id = ti.category_id
     WHERE t.user_id = $1 AND t.id = $2 AND t.deleted = false
     GROUP BY t.id`,
    [userId, id]
  );

  if (result.rowCount === 0) {
    throw new ApiError(404, 'NOT_FOUND', 'Transaction not found');
  }

  return withSummaryFields(result.rows[0]);
}

function withSummaryFields(transaction) {
  const firstItem = transaction.items[0];
  return {
    ...transaction,
    description: transaction.ticket || transaction.paidTo,
    categoryId: firstItem?.categoryId || null,
    category: firstItem?.category || 'Multiple',
    type: transaction.items.some((item) => item.category === 'ingreso') ? 'income' : 'expense',
  };
}
