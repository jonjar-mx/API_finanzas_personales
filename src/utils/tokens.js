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
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({
    sub: user.id,
    email: user.email,
    name: user.display_name || user.displayName,
    role: user.role || 'user',
    iat: now,
    exp: now + config.sessionTtlSeconds
  });
  const unsignedToken = `${header}.${payload}`;
  return `${unsignedToken}.${sign(unsignedToken)}`;
}

export function verifySessionToken(token) {
  const [header, payload, signature] = String(token || '').split('.');
  if (!header || !payload || !signature) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Invalid session token');
  }

  const decodedHeader = decode(header);
  if (decodedHeader.alg !== 'HS256' || decodedHeader.typ !== 'JWT') {
    throw new ApiError(401, 'UNAUTHORIZED', 'Invalid session token');
  }

  const unsignedToken = `${header}.${payload}`;
  const expectedSignature = sign(unsignedToken);
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
