import dotenv from 'dotenv';

dotenv.config();

const defaultCorsOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://192.168.1.231:3000'
];

function parseCorsOrigins(value) {
  if (!value) {
    return defaultCorsOrigins;
  }

  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export const config = {
  port: Number(process.env.PORT || 4000),
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL,
  devUserEmail: process.env.DEV_USER_EMAIL || 'demo@finanzas.local',
  corsOrigins: parseCorsOrigins(process.env.CORS_ORIGINS),
  authSecret: process.env.AUTH_SECRET || 'dev-finanzas-auth-secret-change-me',
  sessionTtlSeconds: Number(process.env.SESSION_TTL_SECONDS || 60 * 60 * 24 * 7)
};
