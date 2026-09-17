import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import pg from 'pg';

export interface Database {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<T>>;
  transaction<T>(fn: (db: Database) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

class ClientDatabase implements Database {
  constructor(private readonly client: PoolClient) {}
  query<T extends QueryResultRow>(text: string, values: readonly unknown[] = []) {
    return this.client.query<T>(text, [...values]);
  }
  async transaction<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    return fn(this);
  }
  async close() {}
}

export class PostgresDatabase implements Database {
  constructor(private readonly pool: Pool) {}

  query<T extends QueryResultRow>(text: string, values: readonly unknown[] = []) {
    return this.pool.query<T>(text, [...values]);
  }

  async transaction<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const value = await fn(new ClientDatabase(client));
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
  return new PostgresDatabase(pool);
}
