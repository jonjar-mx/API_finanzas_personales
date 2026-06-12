export const PLAN_TIERS = ['free', 'individual', 'family'];

export const FREE_TIER_RETENTION_DAYS = 180;
export const FREE_TIER_RENEWAL_GRACE_DAYS = 30;

const tierDefinitions = {
  free: {
    label: 'Free',
    modules: {
      accounts: true,
      accountSharing: false,
      transactions: true,
      budgets: true,
      alerts: true,
    },
    limits: {
      ownAccounts: 4,
      transactionRetentionDays: FREE_TIER_RETENTION_DAYS,
      renewalGraceDays: FREE_TIER_RENEWAL_GRACE_DAYS,
    },
  },
  individual: {
    label: 'Individual',
    modules: {
      accounts: true,
      accountSharing: false,
      transactions: true,
      budgets: true,
      alerts: true,
    },
    limits: {
      ownAccounts: null,
      transactionRetentionDays: null,
      renewalGraceDays: null,
    },
  },
  family: {
    label: 'Familia',
    modules: {
      accounts: true,
      accountSharing: true,
      transactions: true,
      budgets: true,
      alerts: true,
    },
    limits: {
      ownAccounts: null,
      transactionRetentionDays: null,
      renewalGraceDays: null,
    },
  },
};

export function normalizePlanTier(value) {
  return PLAN_TIERS.includes(value) ? value : 'free';
}

export function getTierCapabilities(tier) {
  const normalizedTier = normalizePlanTier(tier);
  const definition = tierDefinitions[normalizedTier];
  return {
    tier: normalizedTier,
    label: definition.label,
    modules: { ...definition.modules },
    limits: { ...definition.limits },
    canShareAccounts: definition.modules.accountSharing,
  };
}

export function attachSubscription(user) {
  const planTier = normalizePlanTier(user.planTier || user.plan_tier);
  const capabilities = getTierCapabilities(planTier);
  return {
    ...user,
    planTier,
    subscription: {
      tier: planTier,
      label: capabilities.label,
      planChangedAt: user.planChangedAt || user.plan_changed_at || null,
      freeGraceStartedAt: user.freeGraceStartedAt || user.free_grace_started_at || null,
    },
    capabilities,
  };
}

export function requirePlanTier(value) {
  if (typeof value !== 'string' || !PLAN_TIERS.includes(value)) {
    const allowed = PLAN_TIERS.join(', ');
    const error = new Error(`planTier must be one of: ${allowed}`);
    error.code = 'INVALID_PLAN_TIER';
    throw error;
  }
  return value;
}
