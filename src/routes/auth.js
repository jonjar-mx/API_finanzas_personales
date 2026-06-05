import { Router } from 'express';
import { pool } from '../db/pool.js';
import { ApiError, asyncHandler } from '../utils/errors.js';
import { requireText } from '../utils/validation.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { createSessionToken } from '../utils/tokens.js';

export const authRouter = Router();

const userColumns = 'id, email, display_name AS "displayName"';

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

function toAuthResponse(user) {
  return {
    token: createSessionToken({ id: user.id, email: user.email, display_name: user.displayName }),
    user
  };
}

authRouter.post('/register', asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const displayName = requireText(req.body.displayName || req.body.name || email.split('@')[0], 'displayName');
  const password = requirePassword(req.body.password);

  const result = await pool.query(
    `INSERT INTO users (email, display_name, password_hash)
     VALUES ($1, $2, $3)
     RETURNING ${userColumns}`,
    [email, displayName, hashPassword(password)]
  );

  res.status(201).json(toAuthResponse(result.rows[0]));
}));

authRouter.post('/login', asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const password = requireText(req.body.password, 'password');

  const result = await pool.query(
    `SELECT id, email, display_name AS "displayName", password_hash AS "passwordHash"
     FROM users
     WHERE email = $1`,
    [email]
  );

  const user = result.rows[0];
  if (!user || !verifyPassword(password, user.passwordHash)) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Invalid email or password');
  }

  delete user.passwordHash;
  res.json(toAuthResponse(user));
}));

authRouter.get('/me', asyncHandler(async (req, res) => {
  res.json({ user: req.user });
}));
