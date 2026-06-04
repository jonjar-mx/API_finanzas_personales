import { ApiError } from './errors.js';

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const monthRegex = /^\d{4}-(0[1-9]|1[0-2])$/;
const dateRegex = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const colorRegex = /^#[0-9a-f]{6}$/i;

export function requireUuid(value, field = 'id') {
  if (!uuidRegex.test(String(value || ''))) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${field} must be a valid uuid`, { field });
  }
  return value;
}

export function requireMonth(value) {
  if (!monthRegex.test(String(value || ''))) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'month must use YYYY-MM format', { field: 'month' });
  }
  return value;
}

export function toMonthDate(value) {
  return `${requireMonth(value)}-01`;
}

export function requireDate(value, field = 'date') {
  if (!dateRegex.test(String(value || ''))) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${field} must use YYYY-MM-DD format`, { field });
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${field} must be a valid calendar date`, { field });
  }

  return value;
}

export function optionalDate(value, field) {
  return value === undefined ? undefined : requireDate(value, field);
}

export function requireAmount(value, { field = 'amount', allowZero = false } = {}) {
  const amount = Number(value);
  const valid = Number.isFinite(amount) && (allowZero ? amount >= 0 : amount > 0);
  if (!valid) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${field} must be ${allowZero ? 'zero or greater' : 'greater than zero'}`, { field });
  }

  return amount.toFixed(2);
}

export function optionalAmount(value, options) {
  return value === undefined ? undefined : requireAmount(value, options);
}

export function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApiError(400, 'VALIDATION_ERROR', `${field} is required`, { field });
  }
  return value.trim();
}

export function optionalText(value, field) {
  if (value === undefined || value === null) {
    return value === null ? null : undefined;
  }
  return requireText(value, field);
}

export function optionalColor(value) {
  if (value === undefined || value === null || value === '') {
    return value ?? null;
  }
  if (!colorRegex.test(value)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'color must be a hex color', { field: 'color' });
  }
  return value;
}

export function requireType(value) {
  if (!['expense', 'income'].includes(value)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'type must be expense or income', { field: 'type' });
  }
  return value;
}

export function optionalType(value) {
  return value === undefined ? undefined : requireType(value);
}
