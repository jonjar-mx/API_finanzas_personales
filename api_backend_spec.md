# API Specification - Finanzas Personales

## Purpose

Define the HTTP API that connects the React frontend with the PostgreSQL database.

The API replaces frontend-only `localStorage` persistence with server-side persistence for categories, budgets, transactions, and monthly dashboard data.

## Recommended Stack

Any backend stack can implement this contract. Recommended options:

- Node.js with Express or Fastify.
- PostgreSQL through `pg`, Prisma, Drizzle, or Knex.
- JSON over HTTPS.

## Base URL

Development:

```text
http://localhost:4000/api
```

Production:

```text
https://<domain>/api
```

## Authentication

All endpoints except health checks require an authenticated user.

Request header:

```http
Authorization: Bearer <access_token>
```

For the first local implementation, a temporary development user may be injected by middleware. Do not ship production without real authentication.

## Common Response Format

Success responses return JSON data directly:

```json
{
  "id": "uuid",
  "name": "Food"
}
```

Error responses use:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Amount must be greater than zero",
    "details": {}
  }
}
```

## Error Codes

- `UNAUTHORIZED`
- `FORBIDDEN`
- `NOT_FOUND`
- `VALIDATION_ERROR`
- `CONFLICT`
- `INTERNAL_ERROR`

## Health

### GET /health

Returns backend status.

Response:

```json
{
  "status": "ok"
}
```

## Categories

### GET /categories

Returns categories for the authenticated user.

Response:

```json
[
  {
    "id": "uuid",
    "name": "Food",
    "color": "#3b82f6",
    "icon": "utensils",
    "sortOrder": 2
  }
]
```

### POST /categories

Creates a category.

Request:

```json
{
  "name": "Food",
  "color": "#3b82f6",
  "icon": "utensils",
  "sortOrder": 2
}
```

Response: `201 Created`

```json
{
  "id": "uuid",
  "name": "Food",
  "color": "#3b82f6",
  "icon": "utensils",
  "sortOrder": 2
}
```

### PATCH /categories/:id

Updates category metadata.

### DELETE /categories/:id

Deletes a category only when it has no blocking dependencies, or archives it if archive support is implemented.

## Budgets

### GET /budgets?month=YYYY-MM

Returns budgets for a month.

Response:

```json
[
  {
    "id": "uuid",
    "categoryId": "uuid",
    "category": "Food",
    "month": "2026-06",
    "amount": 450.00,
    "spent": 86.35,
    "remaining": 363.65,
    "progress": 19.19
  }
]
```

### POST /budgets

Creates or updates the monthly budget for a category.

Request:

```json
{
  "categoryId": "uuid",
  "month": "2026-06",
  "amount": 450.00
}
```

Behavior:

- Normalize `month` to the first day of the month in PostgreSQL.
- If a budget already exists for the user, category, and month, update the amount.
- Return the stored budget.

Response: `201 Created` or `200 OK`

```json
{
  "id": "uuid",
  "categoryId": "uuid",
  "category": "Food",
  "month": "2026-06",
  "amount": 450.00
}
```

### PATCH /budgets/:id

Updates a budget amount.

Request:

```json
{
  "amount": 500.00
}
```

### DELETE /budgets/:id

Deletes a monthly budget. Transactions remain unchanged.

## Transactions

### GET /transactions?month=YYYY-MM

Returns transactions for a month ordered by date descending.

Optional filters:

- `categoryId=uuid`
- `from=YYYY-MM-DD`
- `to=YYYY-MM-DD`
- `type=expense|income`

Response:

```json
[
  {
    "id": "uuid",
    "date": "2026-06-04",
    "categoryId": "uuid",
    "category": "Utilities",
    "description": "Electric bill",
    "amount": 96.12,
    "type": "expense",
    "notes": null
  }
]
```

### POST /transactions

Creates a transaction.

Request:

```json
{
  "date": "2026-06-04",
  "categoryId": "uuid",
  "description": "Electric bill",
  "amount": 96.12,
  "type": "expense",
  "notes": null
}
```

Response: `201 Created`

```json
{
  "id": "uuid",
  "date": "2026-06-04",
  "categoryId": "uuid",
  "category": "Utilities",
  "description": "Electric bill",
  "amount": 96.12,
  "type": "expense",
  "notes": null
}
```

### PATCH /transactions/:id

Updates a transaction.

Editable fields:

- `date`
- `categoryId`
- `description`
- `amount`
- `type`
- `notes`

### DELETE /transactions/:id

Deletes a transaction.

Response: `204 No Content`

## Dashboard

### GET /dashboard?month=YYYY-MM

Returns aggregated monthly data for the dashboard.

Response:

```json
{
  "month": "2026-06",
  "totals": {
    "budgeted": 2720.00,
    "spent": 1450.45,
    "remaining": 1269.55
  },
  "budgets": [
    {
      "budgetId": "uuid",
      "categoryId": "uuid",
      "category": "Food",
      "amount": 450.00,
      "spent": 86.35,
      "remaining": 363.65,
      "progress": 19.19
    }
  ]
}
```

The frontend dashboard should prefer this endpoint instead of recalculating progress locally after the API is introduced.

## Frontend Integration Plan

1. Create `src/api/client.js` with a configured HTTP client.
2. Replace `localStorage` reads in `BudgetContext` with API calls.
3. Load categories on app start.
4. Load dashboard data when `currentMonth` changes.
5. Load transactions when `currentMonth` changes or filters change.
6. Update local UI state after successful POST/PATCH/DELETE responses.
7. Show loading, empty, and error states.

## Environment Variables

Frontend:

```text
VITE_API_BASE_URL=http://localhost:4000/api
```

Backend:

```text
DATABASE_URL=postgres://user:password@localhost:5432/finanzas_personales
PORT=4000
NODE_ENV=development
```

## CORS

Development backend should allow:

```text
http://localhost:3000
http://127.0.0.1:3000
http://192.168.1.231:3000
```

Production backend should allow only the production frontend origin.

## Validation

All write endpoints must validate:

- Required fields.
- Amount precision and positivity.
- Date format.
- Month format.
- Category ownership.
- Budget ownership.
- Transaction ownership.

## Security Requirements

- Never trust user IDs from request bodies.
- Derive `user_id` from authentication middleware.
- Use parameterized SQL or a safe ORM.
- Validate all request bodies before database writes.
- Return generic internal error messages.
- Keep CORS restrictive in production.

## Testing Scope

Minimum backend tests:

- Category CRUD.
- Budget create/update behavior for duplicate month/category.
- Transaction CRUD.
- Dashboard aggregation.
- Ownership checks.
- Validation failures.

Minimum frontend integration tests:

- Dashboard loads API data.
- Month navigation reloads dashboard.
- Transaction form posts data and refreshes list.
- Budget form posts data and refreshes dashboard.
- API errors display a user-visible error state.

## Open Decisions

- Exact backend framework.
- Auth provider.
- Whether to use a query builder, ORM, or raw SQL.
- Whether API should return cents as integers instead of decimals.
- Whether offline mode with `localStorage` should remain as fallback.
