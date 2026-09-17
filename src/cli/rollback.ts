import { createDatabase } from '../db.js';
import { rollbackLatest } from './migrations.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const db = createDatabase(databaseUrl);
try {
  const version = await rollbackLatest(db);
  process.stdout.write(version ? `Rolled back ${version}.\n` : 'No migration to roll back.\n');
} finally {
  await db.close();
}
