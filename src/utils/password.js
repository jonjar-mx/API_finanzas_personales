import crypto from 'crypto';

const algorithm = 'pbkdf2_sha256';
const iterations = 210000;
const keyLength = 32;
const digest = 'sha256';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.pbkdf2Sync(password, salt, iterations, keyLength, digest).toString('base64url');
  return `${algorithm}$${iterations}$${salt}$${hash}`;
}

export function verifyPassword(password, storedHash) {
  if (!storedHash) {
    return false;
  }

  const [storedAlgorithm, storedIterations, salt, expectedHash] = storedHash.split('$');
  if (storedAlgorithm !== algorithm || !storedIterations || !salt || !expectedHash) {
    return false;
  }

  const computedHash = crypto
    .pbkdf2Sync(password, salt, Number(storedIterations), keyLength, digest)
    .toString('base64url');

  const expected = Buffer.from(expectedHash);
  const computed = Buffer.from(computedHash);
  return expected.length === computed.length && crypto.timingSafeEqual(expected, computed);
}
