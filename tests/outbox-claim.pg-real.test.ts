/**
 * Real-PostgreSQL proof that the notification outbox claim (src/routes/notifications.ts's
 * `SELECT ... FOR UPDATE SKIP LOCKED` + `UPDATE ... WHERE id = ANY(...)` pattern) actually
 * prevents two concurrent transactions from claiming the same row.
 *
 * This is deliberately NOT part of the default `pnpm test` suite. pg-mem (used by every other
 * test file in this repo — see tests/partners.test.ts, tests/notifications.test.ts) parses
 * `FOR UPDATE SKIP LOCKED` but does not implement it in its query planner (verified against
 * pg-mem 3.0.14: the statement throws "not supported" / "not read by the query planner"). A test
 * that ran this exact SQL against pg-mem could not prove anything about real Postgres MVCC/row
 * locking — running it there would just be asserting pg-mem's single-connection, effectively
 * serial behavior, which is a different (weaker) claim than "two concurrent PostgreSQL
 * transactions can never claim the same row". Prior revisions of this codebase made that false
 * claim; this file is what actually proves it, and only against a real server.
 *
 * How to run this test against a real, disposable PostgreSQL instance (never run against a
 * shared/production database — this test creates and drops its own schema objects):
 *
 *   ROTA_CERTA_TEST_REAL_PG_URL="postgres://user:password@localhost:5432/rota_certa_test" \
 *     pnpm exec vitest run tests/outbox-claim.pg-real.test.ts
 *
 * Without that variable set, every test in this file is skipped (not failed) — this is
 * intentional so `pnpm test` never requires a real PostgreSQL server. Standing up a real
 * PostgreSQL instance (Docker/WSL) for staging is explicitly a separate, later step per this
 * task's own constraints and is NOT performed by this test file or by running it.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresDatabase, type Database } from '../src/db.js';
import { migrate } from '../src/cli/migrations.js';

const REAL_PG_URL = process.env.ROTA_CERTA_TEST_REAL_PG_URL;

const LEASE_SECONDS = 120;

describe.skipIf(!REAL_PG_URL)('Notification outbox claim — real PostgreSQL concurrency proof (gated)', () => {
  let pool: pg.Pool;
  let db: Database;
  let partnerId: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: REAL_PG_URL, max: 10 });
    db = new PostgresDatabase(pool); // default capabilities: { supportsSkipLocked: true } — the real path.
    expect(db.capabilities.supportsSkipLocked).toBe(true);
    await migrate(db);
    partnerId = randomUUID();
    await db.query(
      `INSERT INTO partners (id,code,display_name,email,commission_type,commission_fixed_cents,currency,active)
       VALUES ($1,$2,'Concurrency Test Partner',$3,'fixed',1000,'EUR',true)
       ON CONFLICT (code) DO NOTHING`,
      [partnerId, `pgreal-${randomUUID().slice(0, 8)}`, `pgreal-${randomUUID().slice(0, 8)}@example.invalid`],
    );
  });

  afterAll(async () => {
    if (db) await db.query('DELETE FROM partners WHERE id=$1', [partnerId]);
    if (db) await db.close();
  });

  it('never lets two concurrent transactions claim the same outbox row, and claims every row exactly once between them', async () => {
    const rowCount = 40;
    const ids = Array.from({ length: rowCount }, () => randomUUID());
    for (const id of ids) {
      await db.query(
        `INSERT INTO notification_outbox (id,idempotency_key,event_type,partner_id,payload,status)
         VALUES ($1,$2,'referral_confirmed',$3,'{}'::jsonb,'pending')`,
        [id, `concurrency-test:${id}`, partnerId],
      );
    }

    // Two real, independent connections/transactions, each racing to claim from the same pool of
    // rows via the production claim query. Both SELECTs are issued before either commits, so if
    // the implementation were the old `UPDATE ... WHERE id IN (SELECT ...)` pattern (no real row
    // locking), both subqueries could read the same "still pending" snapshot and both UPDATEs
    // could then claim overlapping ids. FOR UPDATE SKIP LOCKED is what prevents that.
    const clientA = await pool.connect();
    const clientB = await pool.connect();
    const tokenA = randomUUID();
    const tokenB = randomUUID();
    try {
      await clientA.query('BEGIN');
      await clientB.query('BEGIN');

      const claim = (client: pg.PoolClient) =>
        client.query<{ id: string }>(
          `SELECT id FROM notification_outbox
            WHERE next_attempt_at<=now()
              AND (status='pending' OR (status='processing' AND lease_expires_at < now()))
            ORDER BY next_attempt_at ASC
            LIMIT $1
            FOR UPDATE SKIP LOCKED`,
          [rowCount],
        );

      const [candidatesA, candidatesB] = await Promise.all([claim(clientA), claim(clientB)]);
      const idsA = candidatesA.rows.map((row) => row.id);
      const idsB = candidatesB.rows.map((row) => row.id);

      // The core assertion: SKIP LOCKED means the two concurrent SELECTs never returned an
      // overlapping row, even though they ran concurrently against the exact same candidate set.
      const overlap = idsA.filter((id) => idsB.includes(id));
      expect(overlap).toEqual([]);

      if (idsA.length) {
        await clientA.query(
          `UPDATE notification_outbox SET status='processing',lock_token=$1,lease_expires_at=now() + ($2 || ' seconds')::interval WHERE id = ANY($3::uuid[])`,
          [tokenA, String(LEASE_SECONDS), idsA],
        );
      }
      if (idsB.length) {
        await clientB.query(
          `UPDATE notification_outbox SET status='processing',lock_token=$1,lease_expires_at=now() + ($2 || ' seconds')::interval WHERE id = ANY($3::uuid[])`,
          [tokenB, String(LEASE_SECONDS), idsB],
        );
      }
      await clientA.query('COMMIT');
      await clientB.query('COMMIT');

      // Together, the two transactions claimed every row exactly once — no row was skipped by
      // both (SKIP LOCKED only skips rows locked by *another* transaction, and there was no third
      // claimant here) and no row was claimed by both.
      expect(idsA.length + idsB.length).toBe(rowCount);
      const claimedByA = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM notification_outbox WHERE lock_token=$1 AND status='processing'", [tokenA]);
      const claimedByB = await db.query<{ count: number }>("SELECT count(*)::int AS count FROM notification_outbox WHERE lock_token=$1 AND status='processing'", [tokenB]);
      expect(claimedByA.rows[0]?.count).toBe(idsA.length);
      expect(claimedByB.rows[0]?.count).toBe(idsB.length);
    } finally {
      clientA.release();
      clientB.release();
      await db.query('DELETE FROM notification_outbox WHERE id = ANY($1::uuid[])', [ids]);
    }
  }, 30_000);
});
