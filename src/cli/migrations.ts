import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Database } from '../db.js';

export async function migrate(db: Database, directory = join(process.cwd(), 'migrations')) {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const files = (await readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name) && !name.endsWith('.down.sql')).sort();
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    const exists = await db.query('SELECT 1 FROM schema_migrations WHERE version=$1', [version]);
    if (exists.rowCount) continue;
    const sql = await readFile(join(directory, file), 'utf8');
    await db.transaction(async (tx) => {
      await tx.query(sql);
      await tx.query('INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING', [version]);
    });
  }
}

export async function rollbackLatest(db: Database, directory = join(process.cwd(), 'migrations')) {
  const result = await db.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1');
  const version = result.rows[0]?.version;
  if (!version) return null;
  const sql = await readFile(join(directory, `${version}.down.sql`), 'utf8');
  await db.query(sql);
  return version;
}
