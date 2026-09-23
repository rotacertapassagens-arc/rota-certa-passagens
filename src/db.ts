import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import pg from 'pg';

/**
 * Runtime capabilities of the underlying connection. `supportsSkipLocked` is true only for a
 * real PostgreSQL server. pg-mem — the in-memory driver this repo's default test suite runs
 * against (see tests/partners.test.ts) — parses `FOR UPDATE SKIP LOCKED` but does not implement
 * it in its query planner (verified against pg-mem 3.0.14: the statement throws "not supported").
 * Code that needs the real MVCC/row-lock guarantee (the notification outbox claim; see
 * src/routes/notifications.ts) must branch on this flag rather than assume every `Database` can
 * run that query. The real guarantee is proven only by the separate, explicitly-gated
 * integration test in tests/outbox-claim.pg-real.test.ts — never by the default pg-mem suite.
 */
export interface DatabaseCapabilities {
  supportsSkipLocked: boolean;
}

const REAL_POSTGRES_CAPABILITIES: DatabaseCapabilities = { supportsSkipLocked: true };

export interface Database {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<T>>;
  transaction<T>(fn: (db: Database) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly capabilities: DatabaseCapabilities;
}

class ClientDatabase implements Database {
  constructor(private readonly client: PoolClient, readonly capabilities: DatabaseCapabilities) {}
  query<T extends QueryResultRow>(text: string, values: readonly unknown[] = []) {
    return this.client.query<T>(text, [...values]);
  }
  async transaction<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    return fn(this);
  }
  async close() {}
}

export class PostgresDatabase implements Database {
  readonly capabilities: DatabaseCapabilities;

  constructor(private readonly pool: Pool, capabilities: DatabaseCapabilities = REAL_POSTGRES_CAPABILITIES) {
    this.capabilities = capabilities;
  }

  query<T extends QueryResultRow>(text: string, values: readonly unknown[] = []) {
    return this.pool.query<T>(text, [...values]);
  }

  async transaction<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const value = await fn(new ClientDatabase(client, this.capabilities));
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

export function createDatabase(connectionString: string): Database {
  const pool = new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
  return new PostgresDatabase(pool, REAL_POSTGRES_CAPABILITIES);
}
