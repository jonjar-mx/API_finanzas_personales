import { Router } from 'express';
import { pool } from '../db/pool.js';
import { ApiError, asyncHandler } from '../utils/errors.js';
import { optionalText, requireAmount, requireText, requireUuid } from '../utils/validation.js';

export const accountsRouter = Router();

const accountTypes = new Set(['cash', 'bank', 'credit_card', 'loan', 'investment', 'external']);
const liquidAccountTypes = new Set(['cash', 'bank']);

const selectColumns = `
  id,
  name,
  business_name AS "businessName",
  address,
  phone,
  email,
  is_own AS "isOwn",
  is_credit AS "isCredit",
  credit_limit::float AS "creditLimit",
  account_type AS "accountType",
  is_liquid AS "isLiquid"
`;

accountsRouter.get('/', asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT ${selectColumns}
     FROM accounts
     WHERE user_id = $1
     ORDER BY is_own DESC, account_type, name`,
    [req.user.id]
  );

  res.json(result.rows);
}));

accountsRouter.post('/', asyncHandler(async (req, res) => {
  const account = normalizeAccount(req.body);
  const result = await pool.query(
    `INSERT INTO accounts (user_id, name, business_name, address, phone, email, is_own, is_credit, credit_limit, account_type, is_liquid)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (user_id, name) DO UPDATE
       SET business_name = COALESCE(EXCLUDED.business_name, accounts.business_name),
           address = COALESCE(EXCLUDED.address, accounts.address),
           phone = COALESCE(EXCLUDED.phone, accounts.phone),
           email = COALESCE(EXCLUDED.email, accounts.email),
           is_own = EXCLUDED.is_own,
           is_credit = EXCLUDED.is_credit,
           credit_limit = EXCLUDED.credit_limit,
           account_type = EXCLUDED.account_type,
           is_liquid = EXCLUDED.is_liquid
     RETURNING ${selectColumns}`,
    [req.user.id, account.name, account.businessName, account.address, account.phone, account.email, account.isOwn, account.isCredit, account.creditLimit, account.accountType, account.isLiquid]
  );

  res.status(201).json(result.rows[0]);
}));

accountsRouter.patch('/:id', asyncHandler(async (req, res) => {
  const id = requireUuid(req.params.id);
  const updates = [];
  const values = [req.user.id, id];
  const normalized = normalizeAccountUpdate(req.body);

  if (req.body.name !== undefined) {
    values.push(requireText(req.body.name, 'name'));
    updates.push(`name = $${values.length}`);
  }
  if (req.body.businessName !== undefined) {
    values.push(req.body.businessName ? optionalText(req.body.businessName, 'businessName') : null);
    updates.push(`business_name = $${values.length}`);
  }
  if (req.body.address !== undefined) {
    values.push(req.body.address ? optionalText(req.body.address, 'address') : null);
    updates.push(`address = $${values.length}`);
  }
  if (req.body.phone !== undefined) {
    values.push(req.body.phone ? optionalText(req.body.phone, 'phone') : null);
    updates.push(`phone = $${values.length}`);
  }
  if (req.body.email !== undefined) {
    values.push(req.body.email ? optionalText(req.body.email, 'email') : null);
    updates.push(`email = $${values.length}`);
  }
  if (normalized.isOwn !== undefined) {
    values.push(normalized.isOwn);
    updates.push(`is_own = $${values.length}`);
  }
  if (normalized.isCredit !== undefined) {
    values.push(normalized.isCredit);
    updates.push(`is_credit = $${values.length}`);
  }
  if (normalized.creditLimit !== undefined) {
    values.push(normalized.creditLimit);
    updates.push(`credit_limit = $${values.length}`);
  }
  if (normalized.accountType !== undefined) {
    values.push(normalized.accountType);
    updates.push(`account_type = $${values.length}`);
  }
  if (normalized.isLiquid !== undefined) {
    values.push(normalized.isLiquid);
    updates.push(`is_liquid = $${values.length}`);
  }

  if (updates.length === 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'No valid fields to update');
  }

  const result = await pool.query(
    `UPDATE accounts
     SET ${updates.join(', ')}
     WHERE user_id = $1 AND id = $2
     RETURNING ${selectColumns}`,
    values
  );

  if (result.rowCount === 0) {
    throw new ApiError(404, 'NOT_FOUND', 'Account not found');
  }

  res.json(result.rows[0]);
}));

function normalizeAccount(body) {
  const normalized = normalizeAccountUpdate(body);

  return {
    name: requireText(body.name, 'name'),
    businessName: body.businessName ? optionalText(body.businessName, 'businessName') : null,
    address: body.address ? optionalText(body.address, 'address') : null,
    phone: body.phone ? optionalText(body.phone, 'phone') : null,
    email: body.email ? optionalText(body.email, 'email') : null,
    isOwn: normalized.isOwn === true,
    isCredit: normalized.isCredit === true,
    creditLimit: normalized.creditLimit ?? 0,
    accountType: normalized.accountType || 'bank',
    isLiquid: normalized.isLiquid ?? liquidAccountTypes.has(normalized.accountType || 'bank'),
  };
}

function normalizeAccountUpdate(body) {
  const accountType = body.accountType !== undefined ? requireAccountType(body.accountType) : inferAccountType(body);
  const isCredit = accountType !== undefined ? accountType === 'credit_card' : requireOptionalBoolean(body.isCredit, 'isCredit');
  const creditLimit = body.creditLimit !== undefined || isCredit !== undefined
    ? requireAmount(isCredit ? (body.creditLimit || 0) : 0, { field: 'creditLimit', allowZero: true })
    : undefined;

  return {
    isOwn: requireOptionalBoolean(body.isOwn, 'isOwn'),
    isCredit,
    creditLimit,
    accountType,
    isLiquid: body.isLiquid !== undefined
      ? requireOptionalBoolean(body.isLiquid, 'isLiquid')
      : accountType !== undefined ? liquidAccountTypes.has(accountType) : undefined,
  };
}

function inferAccountType(body) {
  if (body.isCredit === true) return 'credit_card';
  if (body.isOwn === false) return 'external';
  return undefined;
}

function requireAccountType(value) {
  if (typeof value !== 'string' || !accountTypes.has(value)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'accountType must be a valid account type', { field: 'accountType' });
  }
  return value;
}

function requireOptionalBoolean(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new ApiError(400, 'VALIDATION_ERROR', field + ' must be a boolean', { field });
  }
  return value;
}
