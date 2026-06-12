import { createApp } from './app.js';
import { config } from './config.js';
import { scheduleFreeTierRetention } from './jobs/freeTierRetention.js';

const app = createApp();
scheduleFreeTierRetention();

app.listen(config.port, () => {
  console.log(`API Finanzas listening on http://localhost:${config.port}/api`);
});
