import crypto from 'crypto';
import { config } from '../config.js';
import { ApiError } from './errors.js';

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decode(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function sign(value) {
  return crypto.createHmac('sha256', config.authSecret).update(value).digest('base64url');
}

export function createSessionToken(user) {
  const now = Math.floor(Date.now() / 1000);
  const payload = encode({
    sub: user.id,
    email: user.email,
    name: user.display_name,
    iat: now,
    exp: now + config.sessionTtlSeconds
  });
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(token) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Invalid session token');
  }

  const expectedSignature = sign(payload);
  const expected = Buffer.from(expectedSignature);
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Invalid session token');
  }

  const claims = decode(payload);
  if (!claims.sub || !claims.exp || claims.exp < Math.floor(Date.now() / 1000)) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Session expired');
  }

  return claims;
}
