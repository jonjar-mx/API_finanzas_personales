import { pool } from '../db/pool.js';
import { config } from '../config.js';
import { ApiError } from '../utils/errors.js';

export async function attachUser(req, res, next) {
  if (req.path === '/health') {
    return next();
  }

  try {
    if (config.nodeEnv !== 'development' && !req.get('authorization')) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Authorization header is required');
    }

    const email = config.devUserEmail;
    const result = await pool.query('SELECT id, email, display_name FROM users WHERE email = $1', [email]);
    if (result.rowCount === 0) {
      throw new ApiError(401, 'UNAUTHORIZED', 'Development user does not exist');
    }

    req.user = result.rows[0];
    return next();
  } catch (err) {
    return next(err);
  }
}
