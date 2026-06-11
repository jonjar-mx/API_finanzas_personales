import dotenv from 'dotenv';

dotenv.config();

const defaultCorsOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'http://192.168.1.231:3000',
  'http://192.168.1.231:4173'
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
  sessionTtlSeconds: Number(process.env.SESSION_TTL_SECONDS || 60 * 60 * 24 * 7),
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    startTls: process.env.SMTP_STARTTLS !== 'false',
    user: process.env.SMTP_USER || '',
    password: process.env.SMTP_PASSWORD || '',
    from: process.env.SMTP_FROM || '',
    fromAddress: (process.env.SMTP_FROM || '').match(/<([^>]+)>/)?.[1] || process.env.SMTP_FROM || '',
    heloName: process.env.SMTP_HELO_NAME || 'finanzas-personales.local'
  }
};
