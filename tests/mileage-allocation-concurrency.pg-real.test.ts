/**
 * Real-PostgreSQL proof that allocating miles from a lot (src/routes/finance-mileage.ts's
 * `SELECT ... FOR UPDATE` on fin_mileage_lots, read-balance-then-insert pattern) never lets the
 * lot's balance go negative under real concurrency.
 *
 * Deliberately NOT part of the default `pnpm test` suite, for the exact same reason documented in
 * tests/outbox-claim.pg-real.test.ts: pg-mem (used by tests/finance-mileage.test.ts) does not
 * implement row locking the way real PostgreSQL does — two "concurrent" pg-mem transactions do
 * not actually contend for the same row the way two real Postgres transactions do. A test that
 * asserted "no negative balance" against pg-mem under Promise.all was observed, while building
 * this feature, to let BOTH concurrent allocations succeed (over-allocating a 10-mile lot to 14),
 * which is exactly the bug this real lock is supposed to prevent — so only a real server can prove
 * the fix. That pg-mem run failure is what motivated writing this file instead of trusting the
 * pg-mem result.
 *
 * How to run this test against a real, disposable PostgreSQL instance (never run against a
 * shared/production database — this test creates and drops its own schema objects):
 *
 *   ROTA_CERTA_TEST_REAL_PG_URL="postgres://user:password@localhost:5432/rota_certa_test" \
 *     pnpm exec vitest run tests/mileage-allocation-concurrency.pg-real.test.ts
 *
 * Without that variable set, every test in this file is skipped (not failed).
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresDatabase, type Database } from '../src/db.js';
import { migrate } from '../src/cli/migrations.js';
import { allocationCostCents } from '../shared/mileageCost.js';

const REAL_PG_URL = process.env.ROTA_CERTA_TEST_REAL_PG_URL;

describe.skipIf(!REAL_PG_URL)('Mileage allocation — real PostgreSQL concurrency proof (gated)', () => {
  let pool: pg.Pool;
  let db: Database;
  let counterpartyId: string;
  let categoryId: string;
  let lotId: string;
  let issuanceAId: string;
  let issuanceBId: string;
  let saleId: string;
  let leadId: string;

  const QUANTITY_PURCHASED = 10;
  const TOTAL_COST_CENTS = 1000;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: REAL_PG_URL, max: 10 });
    db = new PostgresDatabase(pool); // default capabilities: { supportsSkipLocked: true } — the real path.
    await migrate(db);

    counterpartyId = randomUUID();
    await db.query(
      "INSERT INTO fin_counterparties (id,display_name,kind) VALUES ($1,'Concurrency Test Mileage Provider','mileage_provider')",
      [counterpartyId],
    );
    categoryId = randomUUID();
    await db.query("INSERT INTO fin_categories (id,kind,name) VALUES ($1,'direct_cost','Concurrency Test Category')", [categoryId]);

    leadId = randomUUID();
    await db.query(
      `INSERT INTO lead_requests (id,kind,status,protocol,adults,children,infants,sale_amount_cents,sale_currency,converted_at)
       VALUES ($1,'flight_quote','converted',$2,1,0,0,100000,'EUR',now())`,
      [leadId, `PGREAL-${randomUUID().slice(0, 8)}`],
    );
    saleId = randomUUID();
    const lead = await db.query<{ protocol: string }>('SELECT protocol FROM lead_requests WHERE id=$1', [leadId]);
    await db.query(
      `INSERT INTO fin_sales (id,lead_request_id,protocol,sale_date,currency,gross_amount_cents,discount_cents,net_amount_cents)
       VALUES ($1,$2,$3,CURRENT_DATE,'EUR',100000,0,100000)`,
      [saleId, leadId, lead.rows[0]!.protocol],
    );

    const obligationId = randomUUID();
    await db.query(
      `INSERT INTO fin_obligations (id,kind,counterparty_id,category_id,competency_date,due_date,amount_cents,currency)
       VALUES ($1,'direct_cost',$2,$3,CURRENT_DATE,CURRENT_DATE,$4,'EUR')`,
      [obligationId, counterpartyId, categoryId, TOTAL_COST_CENTS],
    );
    lotId = randomUUID();
    await db.query(
      `INSERT INTO fin_mileage_lots (id,counterparty_id,program,quantity_purchased,total_cost_cents,currency,unit_cost_micros,purchased_at,obligation_id)
       VALUES ($1,$2,'Concurrency Test Program',$3,$4,'EUR',$5,CURRENT_DATE,$6)`,
      [lotId, counterpartyId, QUANTITY_PURCHASED, TOTAL_COST_CENTS, Math.round((TOTAL_COST_CENTS * 1_000_000) / QUANTITY_PURCHASED), obligationId],
    );

    issuanceAId = randomUUID();
    issuanceBId = randomUUID();
    for (const id of [issuanceAId, issuanceBId]) {
      await db.query("INSERT INTO fin_issuances (id,sale_id,mode,currency) VALUES ($1,$2,'miles','EUR')", [id, saleId]);
    }
  });

  afterAll(async () => {
    if (db) {
      await db.query('DELETE FROM fin_mileage_allocations WHERE lot_id=$1', [lotId]);
      await db.query('DELETE FROM fin_issuances WHERE sale_id=$1', [saleId]);
      await db.query('DELETE FROM fin_mileage_lots WHERE id=$1', [lotId]);
      await db.query('DELETE FROM fin_sales WHERE id=$1', [saleId]);
      await db.query('DELETE FROM fin_obligations WHERE counterparty_id=$1', [counterpartyId]);
      await db.query('DELETE FROM lead_requests WHERE id=$1', [leadId]);
      await db.query('DELETE FROM fin_categories WHERE id=$1', [categoryId]);
      await db.query('DELETE FROM fin_counterparties WHERE id=$1', [counterpartyId]);
      await db.close();
    }
  });

  it('never lets two concurrent transactions over-allocate the same lot below zero balance', async () => {
    // Two real, independent connections/transactions, each racing to allocate 7 of the lot's 10
    // miles — together they demand 14, more than the lot has. If the SELECT ... FOR UPDATE here
    // did not really lock the row, both transactions could read balance=10 before either commits
    // and both could succeed, leaving the lot at -4. This is exactly the scenario that failed
    // against pg-mem while building this feature (see file header) and that this test proves
    // cannot happen against a real server.
    const clientA = await pool.connect();
    const clientB = await pool.connect();
    try {
      await clientA.query('BEGIN');
      await clientB.query('BEGIN');

      const readLockedBalance = async (client: pg.PoolClient) => {
        const lot = await client.query<{ quantity_purchased: number; total_cost_cents: number }>(
          'SELECT quantity_purchased,total_cost_cents FROM fin_mileage_lots WHERE id=$1 FOR UPDATE',
          [lotId],
        );
        const allocated = await client.query<{ sum: number }>(
          'SELECT COALESCE(sum(quantity),0)::int AS sum FROM fin_mileage_allocations WHERE lot_id=$1 AND voided_at IS NULL',
          [lotId],
        );
        return { lot: lot.rows[0]!, allocated: allocated.rows[0]?.sum ?? 0 };
      };

      // clientA acquires the row lock first (issues FOR UPDATE first); clientB's FOR UPDATE blocks
      // until clientA commits or rolls back — that block is the entire point of this proof.
      const stateA = await readLockedBalance(clientA);
      const pendingB = readLockedBalance(clientB);

      const requestQuantity = 7;
      const remainingA = stateA.lot.quantity_purchased - stateA.allocated;
      expect(remainingA).toBeGreaterThanOrEqual(requestQuantity);
      const costA = allocationCostCents(stateA.lot.total_cost_cents, stateA.lot.quantity_purchased, requestQuantity);
      await clientA.query(
        'INSERT INTO fin_mileage_allocations (id,lot_id,issuance_id,quantity,cost_cents_snapshot) VALUES ($1,$2,$3,$4,$5)',
        [randomUUID(), lotId, issuanceAId, requestQuantity, costA],
      );
      await clientA.query('COMMIT');

      // Only now does clientB's blocked FOR UPDATE resolve, and it must see clientA's committed
      // allocation — proving the lock forced a real wait, not just an accidental ordering.
      const stateB = await pendingB;
      const remainingB = stateB.lot.quantity_purchased - stateB.allocated;
      expect(remainingB).toBe(QUANTITY_PURCHASED - requestQuantity);
      expect(remainingB).toBeLessThan(requestQuantity);

      let clientBError: unknown;
      try {
        if (remainingB < requestQuantity) throw new Error('insufficient_mileage_balance');
        const costB = allocationCostCents(stateB.lot.total_cost_cents, stateB.lot.quantity_purchased, requestQuantity);
        await clientB.query(
          'INSERT INTO fin_mileage_allocations (id,lot_id,issuance_id,quantity,cost_cents_snapshot) VALUES ($1,$2,$3,$4,$5)',
          [randomUUID(), lotId, issuanceBId, requestQuantity, costB],
        );
      } catch (error) {
        clientBError = error;
      } finally {
        await clientB.query('ROLLBACK');
      }
      expect((clientBError as Error)?.message).toBe('insufficient_mileage_balance');

      const finalAllocated = await db.query<{ sum: number }>(
        'SELECT COALESCE(sum(quantity),0)::int AS sum FROM fin_mileage_allocations WHERE lot_id=$1 AND voided_at IS NULL',
        [lotId],
      );
      expect(finalAllocated.rows[0]?.sum).toBe(requestQuantity);
      expect(QUANTITY_PURCHASED - (finalAllocated.rows[0]?.sum ?? 0)).toBeGreaterThanOrEqual(0);
    } finally {
      clientA.release();
      clientB.release();
    }
  }, 30_000);
});
