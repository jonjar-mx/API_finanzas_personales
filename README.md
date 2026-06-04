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

En desarrollo, el middleware usa `DEV_USER_EMAIL` para resolver el usuario demo. En produccion, reemplaza ese middleware por autenticacion real y envia `Authorization: Bearer <access_token>`.

## Endpoints

- `GET /api/health`
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
```
