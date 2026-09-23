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
  // Delete the tracking row before running the down migration: some down migrations (e.g.
  // 0001_initial's, which tears the schema back down to nothing) legitimately drop the
  // schema_migrations table itself as their final statement, which would make a delete issued
  // afterwards fail with 'relation does not exist'. Deleting first keeps this atomic within the
  // same transaction (a failing down.sql still rolls back the delete) and works regardless of
  // whether that particular migration's teardown removes the tracking table. Without this delete
  // at all, rollbackLatest never advanced schema_migrations, so a second call re-ran the same
  // down.sql against an already-rolled-back schema and errored.
  await db.transaction(async (tx) => {
    await tx.query('DELETE FROM schema_migrations WHERE version=$1', [version]);
    await tx.query(sql);
  });
  return version;
}
