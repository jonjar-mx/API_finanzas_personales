import crypto from 'node:crypto';
import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAdmin } from '../middleware/auth.js';
import { ApiError, asyncHandler } from '../utils/errors.js';
import { queuePasswordResetEmail } from '../utils/mailer.js';
import { PLAN_TIERS } from '../billing/tiers.js';
import { hashPassword } from '../utils/password.js';
import { optionalText, requireText, requireUuid } from '../utils/validation.js';

export const adminRouter = Router();

adminRouter.use(requireAdmin);

const roles = new Set(['user', 'admin']);
const statuses = new Set(['active', 'disabled']);
const planTiers = new Set(PLAN_TIERS);
const userColumns = `
  id,
  email,
  display_name AS "displayName",
  role,
  status,
  plan_tier AS "planTier",
  plan_changed_at AS "planChangedAt",
  free_grace_started_at AS "freeGraceStartedAt",
  last_login_at AS "lastLoginAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

adminRouter.get('/users', asyncHandler(async (req, res) => {
  const search = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const values = [];
  const where = [];

  if (search) {
    values.push(`%${search.toLowerCase()}%`);
    where.push(`(lower(email) LIKE $${values.length} OR lower(display_name) LIKE $${values.length})`);
  }

  const result = await pool.query(
    `SELECT ${userColumns},
            (SELECT count(*)::int FROM transactions t WHERE t.user_id = users.id) AS "transactionCount"
     FROM users
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY created_at DESC
     LIMIT 200`,
    values
  );

  res.json(result.rows);
}));

adminRouter.post('/users', asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const displayName = requireText(req.body.displayName || req.body.name || email.split('@')[0], 'displayName');
  const role = normalizeRole(req.body.role ?? 'user');
  const status = normalizeStatus(req.body.status ?? 'active');
  const planTier = normalizePlanTier(req.body.planTier ?? 'free');
  const temporaryPassword = req.body.password ? requirePassword(req.body.password) : generateTemporaryPassword();

  const result = await pool.query(
    `INSERT INTO users (email, display_name, password_hash, role, status, plan_tier, free_grace_started_at)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6 = 'free' THEN now() ELSE NULL END)
     RETURNING ${userColumns}`,
    [email, displayName, hashPassword(temporaryPassword), role, status, planTier]
  );

  const user = result.rows[0];
  await writeAudit(req.user.id, user.id, 'user.create', { email, role, status, planTier });
  if (!req.body.password) {
    await queuePasswordResetEmail({ userId: user.id, email: user.email, temporaryPassword });
  }

  res.status(201).json({ user, temporaryPassword: req.body.password ? undefined : temporaryPassword });
}));

adminRouter.patch('/users/:id', asyncHandler(async (req, res) => {
  const id = requireUuid(req.params.id);
  const updates = [];
  const values = [id];
  const metadata = {};

  if (req.body.email !== undefined) {
    const email = normalizeEmail(req.body.email);
    values.push(email);
    updates.push(`email = $${values.length}`);
    metadata.email = email;
  }
  if (req.body.displayName !== undefined || req.body.name !== undefined) {
    const displayName = requireText(req.body.displayName ?? req.body.name, 'displayName');
    values.push(displayName);
    updates.push(`display_name = $${values.length}`);
    metadata.displayName = displayName;
  }
  if (req.body.role !== undefined) {
    const role = normalizeRole(req.body.role);
    ensureSelfKeepsAdmin(req, id, role);
    values.push(role);
    updates.push(`role = $${values.length}`);
    metadata.role = role;
  }
  if (req.body.status !== undefined) {
    const status = normalizeStatus(req.body.status);
    values.push(status);
    updates.push(`status = $${values.length}`);
    metadata.status = status;
  }
  if (req.body.planTier !== undefined) {
    const planTier = normalizePlanTier(req.body.planTier);
    values.push(planTier);
    updates.push(`plan_tier = $${values.length}`);
    updates.push('plan_changed_at = now()');
    updates.push(`free_grace_started_at = CASE WHEN plan_tier <> 'free' AND $${values.length} = 'free' THEN now() WHEN $${values.length} <> 'free' THEN NULL ELSE free_grace_started_at END`);
    metadata.planTier = planTier;
  }

  if (updates.length === 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'No valid fields to update');
  }

  const result = await pool.query(
    `UPDATE users
     SET ${updates.join(', ')}
     WHERE id = $1
     RETURNING ${userColumns}`,
    values
  );

  if (result.rowCount === 0) {
    throw new ApiError(404, 'NOT_FOUND', 'User not found');
  }

  await writeAudit(req.user.id, id, 'user.update', metadata);
  res.json({ user: result.rows[0] });
}));

adminRouter.patch('/users/:id/status', asyncHandler(async (req, res) => {
  const id = requireUuid(req.params.id);
  const status = normalizeStatus(req.body.status);

  const result = await pool.query(
    `UPDATE users
     SET status = $2
     WHERE id = $1
     RETURNING ${userColumns}`,
    [id, status]
  );

  if (result.rowCount === 0) {
    throw new ApiError(404, 'NOT_FOUND', 'User not found');
  }

  await writeAudit(req.user.id, id, 'user.status', { status });
  res.json({ user: result.rows[0] });
}));

adminRouter.patch('/users/:id/role', asyncHandler(async (req, res) => {
  const id = requireUuid(req.params.id);
  const role = normalizeRole(req.body.role);
  ensureSelfKeepsAdmin(req, id, role);

  const result = await pool.query(
    `UPDATE users
     SET role = $2
     WHERE id = $1
     RETURNING ${userColumns}`,
    [id, role]
  );

  if (result.rowCount === 0) {
    throw new ApiError(404, 'NOT_FOUND', 'User not found');
  }

  await writeAudit(req.user.id, id, 'user.role', { role });
  res.json({ user: result.rows[0] });
}));

adminRouter.post('/users/:id/reset-password', asyncHandler(async (req, res) => {
  const id = requireUuid(req.params.id);
  const explicitPassword = req.body.password !== undefined ? requirePassword(req.body.password) : null;
  const temporaryPassword = explicitPassword || generateTemporaryPassword();

  const result = await pool.query(
    `UPDATE users
     SET password_hash = $2
     WHERE id = $1
     RETURNING ${userColumns}`,
    [id, hashPassword(temporaryPassword)]
  );

  if (result.rowCount === 0) {
    throw new ApiError(404, 'NOT_FOUND', 'User not found');
  }

  const user = result.rows[0];
  if (!explicitPassword) {
    await queuePasswordResetEmail({ userId: user.id, email: user.email, temporaryPassword });
  }
  await writeAudit(req.user.id, id, explicitPassword ? 'user.change_password' : 'user.reset_password', {});
  res.json({ user, temporaryPassword: explicitPassword ? undefined : temporaryPassword });
}));

adminRouter.get('/audit-log', asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT log.id,
            log.action,
            log.metadata,
            log.created_at AS "createdAt",
            admin.id AS "adminUserId",
            admin.email AS "adminEmail",
            target.id AS "targetUserId",
            target.email AS "targetEmail"
     FROM admin_audit_log log
     LEFT JOIN users admin ON admin.id = log.admin_user_id
     LEFT JOIN users target ON target.id = log.target_user_id
     ORDER BY log.created_at DESC
     LIMIT 200`
  );

  res.json(result.rows);
}));

function normalizeEmail(value) {
  const email = requireText(value, 'email').toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'email must be valid', { field: 'email' });
  }
  return email;
}

function requirePassword(value) {
  const password = requireText(value, 'password');
  if (password.length < 8) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'password must be at least 8 characters', { field: 'password' });
  }
  return password;
}

function normalizeRole(value) {
  const role = optionalText(value, 'role');
  if (!roles.has(role)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'role must be user or admin', { field: 'role' });
  }
  return role;
}

function normalizeStatus(value) {
  const status = optionalText(value, 'status');
  if (!statuses.has(status)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'status must be active or disabled', { field: 'status' });
  }
  return status;
}

function normalizePlanTier(value) {
  const planTier = optionalText(value, 'planTier');
  if (!planTiers.has(planTier)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'planTier must be free, individual or family', { field: 'planTier' });
  }
  return planTier;
}

function generateTemporaryPassword() {
  return `Tmp-${crypto.randomBytes(9).toString('base64url')}`;
}

function ensureSelfKeepsAdmin(req, id, role) {
  if (req.user.id === id && role !== 'admin') {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Admins cannot remove their own admin role', { field: 'role' });
  }
}

async function writeAudit(adminUserId, targetUserId, action, metadata) {
  await pool.query(
    `INSERT INTO admin_audit_log (admin_user_id, target_user_id, action, metadata)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [adminUserId, targetUserId, action, JSON.stringify(metadata || {})]
  );
}
