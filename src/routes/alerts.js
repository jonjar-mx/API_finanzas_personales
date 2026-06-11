import { Router } from 'express';
import { pool } from '../db/pool.js';
import { ApiError, asyncHandler } from '../utils/errors.js';
import { optionalAmount, optionalDate, optionalText, requireDate, requireText, requireUuid } from '../utils/validation.js';

export const alertsRouter = Router();

const alertTypes = new Set(['payment', 'card_cutoff', 'service', 'budget']);
const recurrenceTypes = new Set(['weekly', 'monthly', 'yearly']);

const selectColumns = `
  pa.id,
  pa.title,
  pa.description,
  pa.alert_type AS "alertType",
  to_char(pa.due_date, 'YYYY-MM-DD') AS "dueDate",
  pa.amount::float AS amount,
  pa.account_id AS "accountId",
  a.name AS "accountName",
  pa.is_paid AS "isPaid",
  pa.is_recurring AS "isRecurring",
  pa.recurrence,
  pa.created_at AS "createdAt",
  pa.updated_at AS "updatedAt"
`;

alertsRouter.get('/', asyncHandler(async (req, res) => {
  const filters = normalizeAlertFilters(req.query);
  const values = [req.user.id];
  const where = ['pa.user_id = $1'];

  if (filters.from) {
    values.push(filters.from);
    where.push(`pa.due_date >= $${values.length}`);
  }

  if (filters.to) {
    values.push(filters.to);
    where.push(`pa.due_date <= $${values.length}`);
  }

  if (!filters.includeCompleted) {
    where.push('pa.is_paid = false');
  }

  const result = await pool.query(
    `SELECT ${selectColumns}
     FROM payment_alerts pa
     LEFT JOIN accounts a ON a.user_id = pa.user_id AND a.id = pa.account_id
     WHERE ${where.join(' AND ')}
     ORDER BY pa.is_paid ASC, pa.due_date ASC, pa.created_at DESC`,
    values
  );

  res.json(result.rows);
}));

alertsRouter.post('/', asyncHandler(async (req, res) => {
  const alert = normalizeAlert(req.body);
  await assertAccount(req.user.id, alert.accountId);

  const result = await pool.query(
    `INSERT INTO payment_alerts (user_id, account_id, title, description, alert_type, due_date, amount, is_paid, is_recurring, recurrence)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [req.user.id, alert.accountId, alert.title, alert.description, alert.alertType, alert.dueDate, alert.amount, alert.isPaid, alert.isRecurring, alert.recurrence]
  );

  const stored = await findAlert(req.user.id, result.rows[0].id);
  res.status(201).json(stored);
}));

alertsRouter.patch('/:id', asyncHandler(async (req, res) => {
  const id = requireUuid(req.params.id);
  const normalized = normalizeAlertUpdate(req.body);
  await assertAccount(req.user.id, normalized.accountId);

  const updates = [];
  const values = [req.user.id, id];

  for (const [column, value] of Object.entries(normalized)) {
    if (value === undefined) continue;
    values.push(value);
    updates.push(`${columnMap[column]} = $${values.length}`);
  }

  if (updates.length === 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'No valid fields to update');
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const existing = await findAlertForUpdate(client, req.user.id, id);

    const result = await client.query(
      `UPDATE payment_alerts
       SET ${updates.join(', ')}
       WHERE user_id = $1 AND id = $2
       RETURNING id`,
      values
    );

    if (result.rowCount === 0) {
      throw new ApiError(404, 'NOT_FOUND', 'Alert not found');
    }

    const stored = await findAlertWithClient(client, req.user.id, id);
    if (normalized.isPaid === true && existing.isPaid === false && stored.isRecurring && stored.recurrence) {
      await createNextRecurringAlert(client, req.user.id, stored);
    }

    await client.query('COMMIT');
    res.json(await findAlert(req.user.id, id));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

alertsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const id = requireUuid(req.params.id);
  const result = await pool.query('DELETE FROM payment_alerts WHERE user_id = $1 AND id = $2', [req.user.id, id]);
  if (result.rowCount === 0) {
    throw new ApiError(404, 'NOT_FOUND', 'Alert not found');
  }
  res.status(204).send();
}));

const columnMap = {
  accountId: 'account_id',
  title: 'title',
  description: 'description',
  alertType: 'alert_type',
  dueDate: 'due_date',
  amount: 'amount',
  isPaid: 'is_paid',
  isRecurring: 'is_recurring',
  recurrence: 'recurrence',
};

async function findAlert(userId, id) {
  return findAlertWithClient(pool, userId, id);
}

async function findAlertWithClient(client, userId, id) {
  const result = await client.query(
    `SELECT ${selectColumns}
     FROM payment_alerts pa
     LEFT JOIN accounts a ON a.user_id = pa.user_id AND a.id = pa.account_id
     WHERE pa.user_id = $1 AND pa.id = $2`,
    [userId, id]
  );

  if (result.rowCount === 0) {
    throw new ApiError(404, 'NOT_FOUND', 'Alert not found');
  }

  return result.rows[0];
}

async function findAlertForUpdate(client, userId, id) {
  const result = await client.query(
    `SELECT ${selectColumns}
     FROM payment_alerts pa
     LEFT JOIN accounts a ON a.user_id = pa.user_id AND a.id = pa.account_id
     WHERE pa.user_id = $1 AND pa.id = $2
     FOR UPDATE OF pa`,
    [userId, id]
  );

  if (result.rowCount === 0) {
    throw new ApiError(404, 'NOT_FOUND', 'Alert not found');
  }

  return result.rows[0];
}

async function createNextRecurringAlert(client, userId, alert) {
  const nextDueDate = getNextDueDate(alert.dueDate, alert.recurrence);
  const existing = await client.query(
    `SELECT id
     FROM payment_alerts
     WHERE user_id = $1
       AND title = $2
       AND due_date = $3
     LIMIT 1`,
    [userId, alert.title, nextDueDate]
  );

  if (existing.rowCount > 0) return;

  await client.query(
    `INSERT INTO payment_alerts (user_id, account_id, title, description, alert_type, due_date, amount, is_paid, is_recurring, recurrence)
     VALUES ($1, $2, $3, $4, $5, $6, $7, false, true, $8)`,
    [userId, alert.accountId, alert.title, alert.description, alert.alertType, nextDueDate, alert.amount, alert.recurrence]
  );
}

async function assertAccount(userId, accountId) {
  if (accountId === undefined || accountId === null) return;
  const result = await pool.query('SELECT 1 FROM accounts WHERE user_id = $1 AND id = $2', [userId, accountId]);
  if (result.rowCount === 0) {
    throw new ApiError(404, 'NOT_FOUND', 'Account not found');
  }
}

function normalizeAlert(body) {
  const alert = normalizeAlertUpdate(body);

  return {
    accountId: alert.accountId ?? null,
    title: requireText(body.title, 'title'),
    description: alert.description ?? null,
    alertType: alert.alertType ?? 'payment',
    dueDate: requireDate(body.dueDate, 'dueDate'),
    amount: alert.amount ?? null,
    isPaid: alert.isPaid === true,
    isRecurring: alert.isRecurring === true,
    recurrence: alert.isRecurring === true ? alert.recurrence : null,
  };
}

function normalizeAlertUpdate(body) {
  const isRecurring = optionalBoolean(body.isRecurring, 'isRecurring');

  return {
    accountId: body.accountId === undefined ? undefined : (body.accountId ? requireUuid(body.accountId, 'accountId') : null),
    title: body.title === undefined ? undefined : requireText(body.title, 'title'),
    description: optionalText(body.description, 'description'),
    alertType: body.alertType === undefined ? undefined : requireAlertType(body.alertType),
    dueDate: optionalDate(body.dueDate, 'dueDate'),
    amount: body.amount === null || body.amount === '' ? null : optionalAmount(body.amount, { field: 'amount', allowZero: true }),
    isPaid: optionalBoolean(body.isPaid, 'isPaid'),
    isRecurring,
    recurrence: normalizeRecurrence(body.recurrence, isRecurring),
  };
}

function normalizeAlertFilters(query) {
  if (query.month) {
    const month = String(query.month);
    const from = requireDate(`${month}-01`, 'month');
    const [year, monthNumber] = month.split('-').map(Number);
    const to = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
    return {
      month,
      from,
      to,
      includeCompleted: query.includeCompleted === 'true',
    };
  }

  return {
    month: null,
    from: optionalDate(query.from, 'from'),
    to: optionalDate(query.to, 'to'),
    includeCompleted: query.includeCompleted === 'true',
  };
}

function getNextDueDate(dueDate, recurrence) {
  if (recurrence === 'weekly') return addDays(dueDate, 7);
  if (recurrence === 'monthly') return addMonthsClamped(dueDate, 1);
  if (recurrence === 'yearly') return addYearsClamped(dueDate, 1);
  throw new ApiError(400, 'VALIDATION_ERROR', 'recurrence must be weekly, monthly or yearly', { field: 'recurrence' });
}

function addDays(dateString, days) {
  const date = parseDateParts(dateString);
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return formatDate(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
}

function addMonthsClamped(dateString, months) {
  const date = parseDateParts(dateString);
  const targetMonthIndex = date.month - 1 + months;
  const targetYear = date.year + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12 + 1;
  const targetDay = Math.min(date.day, getLastDayOfMonth(targetYear, targetMonth));
  return formatDate(targetYear, targetMonth, targetDay);
}

function addYearsClamped(dateString, years) {
  const date = parseDateParts(dateString);
  const targetYear = date.year + years;
  const targetDay = Math.min(date.day, getLastDayOfMonth(targetYear, date.month));
  return formatDate(targetYear, date.month, targetDay);
}

function parseDateParts(dateString) {
  const [year, month, day] = dateString.split('-').map(Number);
  return { year, month, day };
}

function getLastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function formatDate(year, month, day) {
  return [year, month, day]
    .map((part, index) => index === 0 ? String(part) : String(part).padStart(2, '0'))
    .join('-');
}

function requireAlertType(value) {
  if (typeof value !== 'string' || !alertTypes.has(value)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'alertType must be payment, card_cutoff, service or budget', { field: 'alertType' });
  }
  return value;
}

function normalizeRecurrence(value, isRecurring) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !recurrenceTypes.has(value)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'recurrence must be weekly, monthly or yearly', { field: 'recurrence' });
  }
  if (isRecurring === false) return null;
  return value;
}

function optionalBoolean(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new ApiError(400, 'VALIDATION_ERROR', field + ' must be a boolean', { field });
  }
  return value;
}
