import { Router } from 'express';
import { pool } from '../db/pool.js';
import { ApiError, asyncHandler } from '../utils/errors.js';
import { optionalText, requireAmount, requireText, requireUuid } from '../utils/validation.js';

export const accountsRouter = Router();

const accountTypes = new Set(['cash', 'bank', 'credit_card', 'loan', 'investment', 'external']);
const liquidAccountTypes = new Set(['cash', 'bank']);
const accountRoles = new Set(['owner', 'admin', 'expender', 'reader']);
const manageableRoles = new Set(['owner', 'admin']);

const selectColumns = `
  a.id,
  a.user_id AS "ownerUserId",
  owner.email AS "ownerEmail",
  owner.plan_tier AS "ownerPlanTier",
  a.name,
  a.business_name AS "businessName",
  a.address,
  a.phone,
  a.email,
  a.is_own AS "isOwn",
  a.is_credit AS "isCredit",
  a.credit_limit::float AS "creditLimit",
  a.account_type AS "accountType",
  a.is_liquid AS "isLiquid",
  am.role AS "accessRole"
`;

accountsRouter.get('/', asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT ${selectColumns},
            COALESCE(
              json_agg(
                json_build_object(
                  'userId', member_user.id,
                  'email', member_user.email,
                  'displayName', member_user.display_name,
                  'role', member.role
                )
                ORDER BY CASE member.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'expender' THEN 2 ELSE 3 END,
                         member_user.email
              ) FILTER (WHERE member.user_id IS NOT NULL),
              '[]'::json
            ) AS members
     FROM accounts a
     JOIN account_members am ON am.account_id = a.id AND am.user_id = $1
     JOIN users owner ON owner.id = a.user_id
     LEFT JOIN account_members member ON member.account_id = a.id
     LEFT JOIN users member_user ON member_user.id = member.user_id
     GROUP BY a.id, owner.email, owner.plan_tier, am.role
     ORDER BY a.is_own DESC, a.account_type, a.name`,
    [req.user.id]
  );

  res.json(result.rows.map(withCapabilities));
}));

accountsRouter.post('/', asyncHandler(async (req, res) => {
  const account = normalizeAccount(req.body);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    if (account.isOwn) {
      const existing = await client.query('SELECT id FROM accounts WHERE user_id = $1 AND lower(name) = lower($2)', [req.user.id, account.name]);
      await assertOwnAccountLimit(client, req.user, existing.rows[0]?.id || null);
    }
    const result = await client.query(
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
       RETURNING id`,
      [req.user.id, account.name, account.businessName, account.address, account.phone, account.email, account.isOwn, account.isCredit, account.creditLimit, account.accountType, account.isLiquid]
    );

    await client.query(
      `INSERT INTO account_members (account_id, user_id, role, created_by_user_id)
       VALUES ($1, $2, 'owner', $2)
       ON CONFLICT (account_id, user_id) DO UPDATE SET role = 'owner'`,
      [result.rows[0].id, req.user.id]
    );
    await client.query('COMMIT');

    res.status(201).json(await findAccount(req.user.id, result.rows[0].id));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

accountsRouter.patch('/:id', asyncHandler(async (req, res) => {
  const id = requireUuid(req.params.id);
  await requireAccountRole(req.user.id, id, manageableRoles);
  const updates = [];
  const values = [id];
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
    if (normalized.isOwn) {
      await assertOwnAccountLimit(pool, req.user, id);
    }
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
     WHERE id = $1
     RETURNING id`,
    values
  );

  if (result.rowCount === 0) {
    throw new ApiError(404, 'NOT_FOUND', 'Account not found');
  }

  res.json(await findAccount(req.user.id, id));
}));

accountsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const id = requireUuid(req.params.id);
  const membership = await requireAccountRole(req.user.id, id, new Set(['owner']));
  if (membership.ownerUserId !== req.user.id) {
    throw new ApiError(403, 'FORBIDDEN', 'Only the account owner can delete the account');
  }

  const dependencies = await pool.query(
    `SELECT EXISTS(
       SELECT 1 FROM transactions
       WHERE paid_by_account_id = $1 OR paid_to_account_id = $1
     ) AS has_transactions`,
    [id]
  );
  if (dependencies.rows[0].has_transactions) {
    throw new ApiError(409, 'CONFLICT', 'Account has transactions');
  }

  await pool.query('DELETE FROM accounts WHERE id = $1', [id]);
  res.status(204).send();
}));

accountsRouter.get('/:id/members', asyncHandler(async (req, res) => {
  const id = requireUuid(req.params.id);
  await requireAccountRole(req.user.id, id, accountRoles);
  res.json(await listMembers(id));
}));

accountsRouter.post('/:id/members', asyncHandler(async (req, res) => {
  const id = requireUuid(req.params.id);
  const membership = await requireAccountRole(req.user.id, id, manageableRoles);
  await assertCanShareAccount(membership.ownerUserId);
  const email = normalizeEmail(req.body.email);
  const role = requireAccountMemberRole(req.body.role);
  if (role === 'owner') {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Owner role cannot be assigned', { field: 'role' });
  }

  const user = await findUserByEmail(email);
  if (!user) {
    throw new ApiError(404, 'NOT_FOUND', 'User not found');
  }

  await pool.query(
    `INSERT INTO account_members (account_id, user_id, role, created_by_user_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (account_id, user_id) DO UPDATE
       SET role = EXCLUDED.role`,
    [id, user.id, role, req.user.id]
  );

  res.status(201).json(await listMembers(id));
}));

accountsRouter.patch('/:id/members/:userId', asyncHandler(async (req, res) => {
  const id = requireUuid(req.params.id);
  const userId = requireUuid(req.params.userId, 'userId');
  const membership = await requireAccountRole(req.user.id, id, manageableRoles);
  await assertCanShareAccount(membership.ownerUserId);
  const role = requireAccountMemberRole(req.body.role);
  if (role === 'owner') {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Owner role cannot be assigned', { field: 'role' });
  }

  const result = await pool.query(
    `UPDATE account_members
     SET role = $3
     WHERE account_id = $1 AND user_id = $2 AND role <> 'owner'`,
    [id, userId, role]
  );
  if (result.rowCount === 0) {
    throw new ApiError(404, 'NOT_FOUND', 'Account member not found');
  }

  res.json(await listMembers(id));
}));

accountsRouter.delete('/:id/members/:userId', asyncHandler(async (req, res) => {
  const id = requireUuid(req.params.id);
  const userId = requireUuid(req.params.userId, 'userId');
  await requireAccountRole(req.user.id, id, manageableRoles);

  const result = await pool.query(
    `DELETE FROM account_members
     WHERE account_id = $1 AND user_id = $2 AND role <> 'owner'`,
    [id, userId]
  );
  if (result.rowCount === 0) {
    throw new ApiError(404, 'NOT_FOUND', 'Account member not found');
  }

  res.status(204).send();
}));

async function findAccount(userId, accountId) {
  const result = await pool.query(
    `SELECT ${selectColumns},
            COALESCE(
              json_agg(
                json_build_object(
                  'userId', member_user.id,
                  'email', member_user.email,
                  'displayName', member_user.display_name,
                  'role', member.role
                )
                ORDER BY CASE member.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'expender' THEN 2 ELSE 3 END,
                         member_user.email
              ) FILTER (WHERE member.user_id IS NOT NULL),
              '[]'::json
            ) AS members
     FROM accounts a
     JOIN account_members am ON am.account_id = a.id AND am.user_id = $1
     JOIN users owner ON owner.id = a.user_id
     LEFT JOIN account_members member ON member.account_id = a.id
     LEFT JOIN users member_user ON member_user.id = member.user_id
     WHERE a.id = $2
     GROUP BY a.id, owner.email, owner.plan_tier, am.role`,
    [userId, accountId]
  );

  if (result.rowCount === 0) {
    throw new ApiError(404, 'NOT_FOUND', 'Account not found');
  }

  return withCapabilities(result.rows[0]);
}

async function listMembers(accountId) {
  const result = await pool.query(
    `SELECT u.id AS "userId",
            u.email,
            u.display_name AS "displayName",
            am.role,
            am.created_at AS "createdAt",
            am.updated_at AS "updatedAt"
     FROM account_members am
     JOIN users u ON u.id = am.user_id
     WHERE am.account_id = $1
     ORDER BY CASE am.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'expender' THEN 2 ELSE 3 END,
              u.email`,
    [accountId]
  );
  return result.rows;
}

async function assertOwnAccountLimit(client, user, excludeAccountId = null) {
  const maxOwnAccounts = user.capabilities?.limits?.ownAccounts;
  if (maxOwnAccounts === null || maxOwnAccounts === undefined) {
    return;
  }

  const values = [user.id];
  let excludeClause = '';
  if (excludeAccountId) {
    values.push(excludeAccountId);
    excludeClause = ` AND id <> $${values.length}`;
  }

  const result = await client.query(
    `SELECT count(*)::int AS count
     FROM accounts
     WHERE user_id = $1 AND is_own = true${excludeClause}`,
    values
  );

  if ((result.rows[0]?.count || 0) >= maxOwnAccounts) {
    throw new ApiError(403, 'PLAN_LIMIT_EXCEEDED', `Free tier allows up to ${maxOwnAccounts} own accounts`, {
      field: 'isOwn',
      limit: maxOwnAccounts,
      planTier: user.planTier,
    });
  }
}

async function assertCanShareAccount(ownerUserId) {
  const result = await pool.query(
    `SELECT plan_tier AS "planTier"
     FROM users
     WHERE id = $1`,
    [ownerUserId]
  );
  const planTier = result.rows[0]?.planTier || 'free';
  if (planTier !== 'family') {
    throw new ApiError(403, 'PLAN_RESTRICTED', 'Account sharing is available only on the family tier', {
      module: 'accountSharing',
      requiredTier: 'family',
      planTier,
    });
  }
}

async function findUserByEmail(email) {
  const result = await pool.query(
    `SELECT id, email
     FROM users
     WHERE email = $1 AND status = 'active'`,
    [email]
  );
  return result.rows[0] || null;
}

async function requireAccountRole(userId, accountId, allowedRoles) {
  const result = await pool.query(
    `SELECT am.role,
            a.user_id AS "ownerUserId"
     FROM account_members am
     JOIN accounts a ON a.id = am.account_id
     WHERE am.account_id = $1 AND am.user_id = $2`,
    [accountId, userId]
  );

  const membership = result.rows[0];
  if (!membership) {
    throw new ApiError(404, 'NOT_FOUND', 'Account not found');
  }
  if (!allowedRoles.has(membership.role)) {
    throw new ApiError(403, 'FORBIDDEN', 'Insufficient account permissions');
  }
  return membership;
}

function withCapabilities(account) {
  const role = account.accessRole;
  const ownerCanShare = account.ownerPlanTier === 'family';
  return {
    ...account,
    canManage: manageableRoles.has(role),
    canShare: manageableRoles.has(role) && ownerCanShare,
    canCreateTransactions: ['owner', 'admin', 'expender'].includes(role),
    canDeleteTransactions: ['owner', 'admin'].includes(role),
    canRead: Boolean(role),
  };
}

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

function normalizeEmail(value) {
  const email = requireText(value, 'email').toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'email must be valid', { field: 'email' });
  }
  return email;
}

function requireAccountType(value) {
  if (typeof value !== 'string' || !accountTypes.has(value)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'accountType must be a valid account type', { field: 'accountType' });
  }
  return value;
}

function requireAccountMemberRole(value) {
  if (typeof value !== 'string' || !accountRoles.has(value)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'role must be owner, admin, expender or reader', { field: 'role' });
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
