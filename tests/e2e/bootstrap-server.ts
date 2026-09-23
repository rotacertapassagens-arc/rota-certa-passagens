/**
 * Playwright test-only server bootstrap. NOT used in production, NOT started by `pnpm dev` or
 * `pnpm start`, and never touched by src/server.ts.
 *
 * Boots the real Fastify app (src/app.ts, unmodified) against an in-memory Postgres emulation
 * (pg-mem) instead of a real PostgreSQL instance — this environment has no real Postgres
 * available (documented as a blocker in the task report) and this repo's own Node test suite
 * already relies on the exact same pg-mem harness for every other backend test. EMAIL_MODE stays
 * 'capture' (the local/test default): no real email provider is contacted, no secret is
 * configured, nothing is actually sent.
 *
 * The one addition beyond the real app is a single debug-only route, /__test__/emails, which
 * returns whatever TestEmailSender captured in-process. In capture mode, an invitation/
 * verification "email" only ever exists as this in-memory message (real EMAIL_MODE=capture
 * writes a hash to email_events, not the raw code) — a genuine browser sitting in front of the
 * real UI has no other way to read a one-time code without a real inbox. This route is the
 * test-harness equivalent of a real E2E suite reading from a test mailbox; it is not part of
 * src/app.ts and ships in no build output.
 */
import { DataType, newDb } from 'pg-mem';
import { PostgresDatabase, type Database } from '../../src/db.js';
import { migrate } from '../../src/cli/migrations.js';
import { buildApp } from '../../src/app.js';
import { TestEmailSender } from '../../src/email.js';
import type { AppConfig } from '../../src/config.js';

const PORT = Number(process.env.E2E_PORT || 4173);

const config: AppConfig = {
  NODE_ENV: 'test',
  PORT,
  APP_ORIGIN: `http://localhost:${PORT}`,
  DATABASE_URL: 'postgres://unused',
  TOKEN_PEPPER: 'e2e-token-pepper-with-more-than-32-characters',
  RATE_LIMIT_SECRET: 'e2e-rate-secret-with-more-than-32-characters',
  SESSION_TTL_HOURS: 24,
  COOKIE_SECURE: false,
  EMAIL_MODE: 'capture',
  EMAIL_FROM: 'E2E <e2e@example.invalid>',
  PAYMENTS_MODE: 'disabled',
  STRIPE_WEBHOOK_SECRET: 'whsec_e2e_test_only',
  MASTER_BOOTSTRAP_TOKEN: 'e2e-bootstrap-token-long-enough-000000',
  WHATSAPP_NOTIFICATIONS_ENABLED: false,
  NOTIFICATIONS_CRON_TOKEN: 'e2e-cron-token-long-enough-for-tests-0',
};

const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
memory.public.registerFunction({ name: 'current_database', returns: DataType.text, implementation: () => 'test' });
memory.public.registerFunction({ name: 'char_length', args: [DataType.text], returns: DataType.integer, implementation: (value: string) => value.length });
const adapter = memory.adapters.createPg();
const pool = new adapter.Pool();
const db: Database = new PostgresDatabase(pool);
await migrate(db);

const emailSender = new TestEmailSender();
const app = await buildApp({ db, config, emailSender });

// Test-only introspection route — see module docstring above.
app.get('/__test__/emails', async () => emailSender.messages);

await app.listen({ port: PORT, host: '127.0.0.1' });
process.stdout.write(`E2E server ready on http://127.0.0.1:${PORT}\n`);
