import { pool } from '../db/pool.js';
import { ApiError } from '../utils/errors.js';
import { verifySessionToken } from '../utils/tokens.js';

const publicRoutes = new Set([
  'GET /health',
  'POST /auth/login',
  'POST /auth/register'
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
      'SELECT id, email, display_name AS "displayName" FROM users WHERE id = $1',
      [claims.sub]
    );
    if (result.rowCount === 0) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Session user does not exist');
    }

    req.user = result.rows[0];
    return next();
  } catch (err) {
    return next(err);
  }
}
