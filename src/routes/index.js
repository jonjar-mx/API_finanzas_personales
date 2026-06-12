import { Router } from 'express';
import { accountsRouter } from './accounts.js';
import { adminRouter } from './admin.js';
import { alertsRouter } from './alerts.js';
import { authRouter } from './auth.js';
import { budgetsRouter } from './budgets.js';
import { categoriesRouter } from './categories.js';
import { dashboardRouter } from './dashboard.js';
import { transactionsRouter } from './transactions.js';

export const router = Router();

router.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

router.use('/auth', authRouter);
router.use('/admin', adminRouter);
router.use('/accounts', accountsRouter);
router.use('/alerts', alertsRouter);
router.use('/categories', categoriesRouter);
router.use('/budgets', budgetsRouter);
router.use('/transactions', transactionsRouter);
router.use('/dashboard', dashboardRouter);
