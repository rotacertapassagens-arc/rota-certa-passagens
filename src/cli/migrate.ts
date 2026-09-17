import { createDatabase } from '../db.js';
import { migrate } from './migrations.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const db = createDatabase(databaseUrl);
try {
  await migrate(db);
  process.stdout.write('Migrations applied successfully.\n');
} finally {
  await db.close();
}
