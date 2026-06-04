import { createApp } from './app.js';
import { config } from './config.js';

const app = createApp();

app.listen(config.port, () => {
  console.log(`API Finanzas listening on http://localhost:${config.port}/api`);
});
