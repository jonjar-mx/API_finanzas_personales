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
  t.paid_by_account_id AS "paidByAccountId",
  t.paid_to_account_id AS "paidToAccountId",
  COALESCE(paid_by_account.name, t.paid_by) AS "paidBy",
  COALESCE(paid_to_account.name, t.paid_to) AS "paidTo",
  t.ticket_code AS ticket,
  t.ticket_link AS "ticketLink",
  t.currency,
  t.transaction_type AS "transactionType",
  COALESCE(SUM(ti.total_price), 0)::float AS amount,
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
  if (req.query.transactionType || req.query.type) {
    values.push(requireTransactionType(req.query.transactionType || req.query.type));
    filters.push(`t.transaction_type = $${values.length}`);
  }

  const result = await pool.query(
    `SELECT ${transactionSelect}
     FROM transactions t
     LEFT JOIN accounts paid_by_account ON paid_by_account.user_id = t.user_id AND paid_by_account.id = t.paid_by_account_id
     LEFT JOIN accounts paid_to_account ON paid_to_account.user_id = t.user_id AND paid_to_account.id = t.paid_to_account_id
     LEFT JOIN transaction_items ti ON ti.user_id = t.user_id AND ti.transaction_id = t.id
     LEFT JOIN categories c ON c.user_id = ti.user_id AND c.id = ti.category_id
     WHERE ${filters.join(' AND ')}
     GROUP BY t.id, paid_by_account.name, paid_to_account.name
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
    const paidByAccount = await ensureAccount(client, req.user.id, transaction.paidBy);
    const paidToAccount = await ensureAccount(client, req.user.id, transaction.paidTo);
    const transactionType = transaction.transactionType
      || inferTransactionType(paidByAccount, paidToAccount, transaction.items);

    const created = await client.query(
      `INSERT INTO transactions (user_id, transaction_date, paid_by_account_id, paid_to_account_id, paid_by, paid_to, ticket_code, ticket_link, currency, transaction_type, notes, created_by_user_id, updated_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $1, $1)
       RETURNING id`,
      [
        req.user.id,
        transaction.date,
        paidByAccount.id,
        paidToAccount.id,
        paidByAccount.name,
        paidToAccount.name,
        transaction.ticket,
        transaction.ticketLink,
        transaction.currency,
        transactionType,
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
  const paidByName = req.body.paidBy !== undefined ? requireText(req.body.paidBy, 'paidBy') : undefined;
  const paidToName = req.body.paidTo !== undefined ? requireText(req.body.paidTo, 'paidTo') : undefined;
  const transactionType = req.body.transactionType !== undefined || req.body.type !== undefined
    ? requireTransactionType(req.body.transactionType || req.body.type)
    : undefined;
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
  values.push(req.user.id);
  updates.push(`updated_by_user_id = $${values.length}`);
  updates.push('updated_at = now()');

  if (updates.length === 2 && !hasItems && paidByName === undefined && paidToName === undefined && transactionType === undefined) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'No valid fields to update');
  }

  try {
    await client.query('BEGIN');

    const existing = await getTransactionForTypeInference(client, req.user.id, id);
    if (!existing) {
      throw new ApiError(404, 'NOT_FOUND', 'Transaction not found');
    }

    if (hasItems) {
      await ensureCategories(client, req.user.id, items.map((item) => item.categoryId));
      await client.query('DELETE FROM transaction_items WHERE user_id = $1 AND transaction_id = $2', [req.user.id, id]);
      await insertItems(client, req.user.id, id, items);
    }

    let paidByAccount = existing.paidByAccount;
    let paidToAccount = existing.paidToAccount;

    if (paidByName !== undefined) {
      paidByAccount = await ensureAccount(client, req.user.id, paidByName);
      values.push(paidByAccount.id);
      updates.push(`paid_by_account_id = $${values.length}`);
      values.push(paidByAccount.name);
      updates.push(`paid_by = $${values.length}`);
    }
    if (paidToName !== undefined) {
      paidToAccount = await ensureAccount(client, req.user.id, paidToName);
      values.push(paidToAccount.id);
      updates.push(`paid_to_account_id = $${values.length}`);
      values.push(paidToAccount.name);
      updates.push(`paid_to = $${values.length}`);
    }
    if (transactionType !== undefined || paidByName !== undefined || paidToName !== undefined || hasItems) {
      values.push(transactionType || inferTransactionType(paidByAccount, paidToAccount, items || existing.items));
      updates.push(`transaction_type = $${values.length}`);
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
    transactionType: body.transactionType !== undefined || body.type !== undefined
      ? requireTransactionType(body.transactionType || body.type)
      : null,
    items: normalizeItems(body.items),
  };
}

function requireTransactionType(value) {
  const allowed = new Set(['expense', 'income', 'transfer', 'credit_payment']);
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'transactionType must be a valid transaction type', { field: 'transactionType' });
  }
  return value;
}

function normalizeItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'items must include at least one item', { field: 'items' });
  }

  return items.map((item, index) => {
    const units = requireQuantity(item.units, `items[${index}].units`);
    const unitPrice = requireMoneyNumber(item.unitPrice, `items[${index}].unitPrice`);
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

function requireQuantity(value, field) {
  const parsed = requireNumber(value, field);
  return Math.round(parsed * 1000000) / 1000000;
}

function requireMoneyNumber(value, field) {
  return roundMoney(requireNumber(value, field));
}

function requireNumber(value, field) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${field} must be a number`, { field });
  }
  return parsed;
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

async function ensureAccount(client, userId, name) {
  const result = await client.query(
    `INSERT INTO accounts (user_id, name)
     VALUES ($1, $2)
     ON CONFLICT (user_id, name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, name, is_own AS "isOwn", account_type AS "accountType"`,
    [userId, requireText(name, 'account')]
  );

  return result.rows[0];
}

async function getTransactionForTypeInference(client, userId, id) {
  const result = await client.query(
    `SELECT
       t.id,
       json_build_object('id', paid_by_account.id, 'name', paid_by_account.name, 'isOwn', paid_by_account.is_own, 'accountType', paid_by_account.account_type) AS "paidByAccount",
       json_build_object('id', paid_to_account.id, 'name', paid_to_account.name, 'isOwn', paid_to_account.is_own, 'accountType', paid_to_account.account_type) AS "paidToAccount",
       COALESCE(
         json_agg(
           json_build_object('categoryId', ti.category_id, 'category', c.name)
         ) FILTER (WHERE ti.id IS NOT NULL),
         '[]'::json
       ) AS items
     FROM transactions t
     LEFT JOIN accounts paid_by_account ON paid_by_account.user_id = t.user_id AND paid_by_account.id = t.paid_by_account_id
     LEFT JOIN accounts paid_to_account ON paid_to_account.user_id = t.user_id AND paid_to_account.id = t.paid_to_account_id
     LEFT JOIN transaction_items ti ON ti.user_id = t.user_id AND ti.transaction_id = t.id
     LEFT JOIN categories c ON c.user_id = ti.user_id AND c.id = ti.category_id
     WHERE t.user_id = $1 AND t.id = $2 AND t.deleted = false
     GROUP BY t.id, paid_by_account.id, paid_by_account.name, paid_by_account.is_own, paid_by_account.account_type, paid_to_account.id, paid_to_account.name, paid_to_account.is_own, paid_to_account.account_type`,
    [userId, id]
  );

  return result.rows[0] || null;
}

function inferTransactionType(paidByAccount, paidToAccount, items) {
  if (paidByAccount?.isOwn && paidToAccount?.isOwn) {
    return ['credit_card', 'loan'].includes(paidToAccount.accountType) ? 'credit_payment' : 'transfer';
  }
  if (paidToAccount?.isOwn && !paidByAccount?.isOwn) {
    return 'income';
  }
  if (items.some((item) => String(item.category || '').trim().toLowerCase() === 'ingreso')) {
    return 'income';
  }
  return 'expense';
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
     LEFT JOIN accounts paid_by_account ON paid_by_account.user_id = t.user_id AND paid_by_account.id = t.paid_by_account_id
     LEFT JOIN accounts paid_to_account ON paid_to_account.user_id = t.user_id AND paid_to_account.id = t.paid_to_account_id
     LEFT JOIN transaction_items ti ON ti.user_id = t.user_id AND ti.transaction_id = t.id
     LEFT JOIN categories c ON c.user_id = ti.user_id AND c.id = ti.category_id
     WHERE t.user_id = $1 AND t.id = $2 AND t.deleted = false
     GROUP BY t.id, paid_by_account.name, paid_to_account.name`,
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
    type: transaction.transactionType,
  };
}
