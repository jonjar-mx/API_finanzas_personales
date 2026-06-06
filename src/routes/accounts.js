import { Router } from 'express';
import { pool } from '../db/pool.js';
import { ApiError, asyncHandler } from '../utils/errors.js';
import { optionalText, requireAmount, requireText, requireUuid } from '../utils/validation.js';

export const accountsRouter = Router();

const selectColumns = `
  id,
  name,
  business_name AS "businessName",
  address,
  phone,
  email,
  is_own AS "isOwn",
  is_credit AS "isCredit",
  credit_limit::float AS "creditLimit"
`;

accountsRouter.get('/', asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT ${selectColumns}
     FROM accounts
     WHERE user_id = $1
     ORDER BY is_own DESC, name`,
    [req.user.id]
  );

  res.json(result.rows);
}));

accountsRouter.post('/', asyncHandler(async (req, res) => {
  const account = normalizeAccount(req.body);
  const result = await pool.query(
    `INSERT INTO accounts (user_id, name, business_name, address, phone, email, is_own, is_credit, credit_limit)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (user_id, name) DO UPDATE
       SET business_name = COALESCE(EXCLUDED.business_name, accounts.business_name),
           address = COALESCE(EXCLUDED.address, accounts.address),
           phone = COALESCE(EXCLUDED.phone, accounts.phone),
           email = COALESCE(EXCLUDED.email, accounts.email),
           is_own = EXCLUDED.is_own,
           is_credit = EXCLUDED.is_credit,
           credit_limit = EXCLUDED.credit_limit
     RETURNING ${selectColumns}`,
    [req.user.id, account.name, account.businessName, account.address, account.phone, account.email, account.isOwn, account.isCredit, account.creditLimit]
  );

  res.status(201).json(result.rows[0]);
}));

accountsRouter.patch('/:id', asyncHandler(async (req, res) => {
  const id = requireUuid(req.params.id);
  const updates = [];
  const values = [req.user.id, id];

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
  if (req.body.isOwn !== undefined) {
    if (typeof req.body.isOwn !== 'boolean') {
      throw new ApiError(400, 'VALIDATION_ERROR', 'isOwn must be a boolean', { field: 'isOwn' });
    }
    values.push(req.body.isOwn);
    updates.push(`is_own = $${values.length}`);
  }
  if (req.body.isCredit !== undefined) {
    if (typeof req.body.isCredit !== 'boolean') {
      throw new ApiError(400, 'VALIDATION_ERROR', 'isCredit must be a boolean', { field: 'isCredit' });
    }
    values.push(req.body.isCredit);
    updates.push(`is_credit = $${values.length}`);
  }
  if (req.body.creditLimit !== undefined) {
    values.push(requireAmount(req.body.creditLimit || 0, { field: 'creditLimit', allowZero: true }));
    updates.push(`credit_limit = $${values.length}`);
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
  if (body.isOwn !== undefined && typeof body.isOwn !== 'boolean') {
    throw new ApiError(400, 'VALIDATION_ERROR', 'isOwn must be a boolean', { field: 'isOwn' });
  }
  if (body.isCredit !== undefined && typeof body.isCredit !== 'boolean') {
    throw new ApiError(400, 'VALIDATION_ERROR', 'isCredit must be a boolean', { field: 'isCredit' });
  }

  const isCredit = body.isCredit === true;

  return {
    name: requireText(body.name, 'name'),
    businessName: body.businessName ? optionalText(body.businessName, 'businessName') : null,
    address: body.address ? optionalText(body.address, 'address') : null,
    phone: body.phone ? optionalText(body.phone, 'phone') : null,
    email: body.email ? optionalText(body.email, 'email') : null,
    isOwn: body.isOwn === true,
    isCredit,
    creditLimit: requireAmount(isCredit ? (body.creditLimit || 0) : 0, { field: 'creditLimit', allowZero: true }),
  };
}
