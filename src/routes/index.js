import { Router } from 'express';
import { budgetsRouter } from './budgets.js';
import { categoriesRouter } from './categories.js';
import { dashboardRouter } from './dashboard.js';
import { transactionsRouter } from './transactions.js';

export const router = Router();

router.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

router.use('/categories', categoriesRouter);
router.use('/budgets', budgetsRouter);
router.use('/transactions', transactionsRouter);
router.use('/dashboard', dashboardRouter);
