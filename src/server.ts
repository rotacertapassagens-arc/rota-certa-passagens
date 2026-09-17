import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db.js';

const config = loadConfig();
const db = createDatabase(config.DATABASE_URL);
const app = await buildApp({ db, config });

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await app.listen({ port: config.PORT, host: '0.0.0.0' });
