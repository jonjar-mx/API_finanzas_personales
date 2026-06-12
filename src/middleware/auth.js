import { pool } from '../db/pool.js';
import { ApiError } from '../utils/errors.js';
import { verifySessionToken } from '../utils/tokens.js';
import { attachSubscription } from '../billing/tiers.js';

const publicRoutes = new Set([
  'GET /health',
  'POST /auth/login',
  'POST /auth/register',
  'POST /auth/forgot-password'
]);

export async function attachUser(req, res, next) {
  if (publicRoutes.has(`${req.method} ${req.path}`)) {
    return next();
  }

  try {
    const authorization = req.get('authorization') || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
    if (!token) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Authorization token is required');
    }

    const claims = verifySessionToken(token);
    const result = await pool.query(
      `SELECT id,
              email,
              display_name AS "displayName",
              role,
              status,
              plan_tier AS "planTier",
              plan_changed_at AS "planChangedAt",
              free_grace_started_at AS "freeGraceStartedAt"
       FROM users
       WHERE id = $1`,
      [claims.sub]
    );
    if (result.rowCount === 0) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Session user does not exist');
    }

    const user = result.rows[0];
    if (user.status !== 'active') {
      throw new ApiError(403, 'FORBIDDEN', 'User account is disabled');
    }

    req.user = attachSubscription(user);
    return next();
  } catch (err) {
    return next(err);
  }
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return next(new ApiError(403, 'FORBIDDEN', 'Admin access is required'));
  }
  return next();
}
