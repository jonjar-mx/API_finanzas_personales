# API Finansas Personales

Backend HTTP para conectar el frontend de finanzas personales con PostgreSQL.

## Requisitos

- Node.js 20+
- PostgreSQL local configurado en `../postgres_finansas_personales`

## Configuracion

```sh
cp .env.example .env
npm install
npm run dev
```

El API queda disponible en:

```text
http://localhost:4000/api
```

La mayoria de endpoints requieren `Authorization: Bearer <access_token>`. `POST /api/auth/login`, `POST /api/auth/register` y `POST /api/auth/forgot-password` son publicos.

Para recuperacion de contrasena, configura SMTP con `SMTP_HOST` y `SMTP_FROM`. Si SMTP no esta configurado, la API guarda el mensaje en `password_reset_emails` como outbox de desarrollo.

## Endpoints

- `GET /api/health`
- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `PATCH /api/auth/profile`
- `PATCH /api/auth/password`
- `POST /api/auth/forgot-password`
- `GET|POST /api/categories`
- `PATCH|DELETE /api/categories/:id`
- `GET|POST /api/budgets`
- `PATCH|DELETE /api/budgets/:id`
- `GET|POST /api/transactions`
- `PATCH|DELETE /api/transactions/:id`
- `GET /api/dashboard`


## Base local

Este repo no incluye la base viva ni secretos. Para desarrollo local usa el proyecto:

```text
../postgres_finansas_personales
```

Variables esperadas en `.env`:

```text
DATABASE_URL=postgresql://finanzas_user:finanzas_password@localhost:5432/postgres_finansas_personales
PORT=4000
NODE_ENV=development
DEV_USER_EMAIL=demo@finanzas.local
AUTH_SECRET=change-this-secret
SESSION_TTL_SECONDS=604800
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_STARTTLS=true
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM=
SMTP_HELO_NAME=finanzas-personales.local
```
