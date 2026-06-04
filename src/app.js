import cors from 'cors';
import express from 'express';
import { config } from './config.js';
import { attachUser } from './middleware/auth.js';
import { errorHandler } from './utils/errors.js';
import { router } from './routes/index.js';

export function createApp() {
  const app = express();

  app.use(cors({
    origin(origin, callback) {
      if (!origin || config.corsOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    }
  }));
  app.use(express.json());
  app.use('/api', attachUser, router);
  app.use(errorHandler);

  return app;
}
