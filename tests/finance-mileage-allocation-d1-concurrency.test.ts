/**
 * Regression test for the Worker/D1 mileage-allocation race condition found during the
 * independent review of 28/09/2026 (see docs/financeiro/REVISAO_INDEPENDENTE.md, GATE 4).
 *
 * Before the fix, `financeMileageAllocationCreate` in worker/index.ts read the lot's remaining
 * balance with one SELECT, then inserted the allocation with a separate INSERT — two requests
 * racing for the same lot (e.g. a double-click, or two open tabs) could both read the same
 * "remaining" value and both pass the balance check, over-allocating the lot past its purchased
 * quantity. D1 has no `SELECT ... FOR UPDATE` and no interactive transaction, so the two
 * statements were never atomic with each other.
 *
 * The fix replaces the separate SELECT+INSERT with a single `INSERT ... SELECT ... WHERE`
 * statement, which SQLite/D1 executes as one atomic unit — the balance check and the write are
 * now the same statement, so two concurrent requests can never both see the same "before" balance.
 *
 * This test runs against the real Cloudflare Workers runtime (Miniflare) and a real D1 (SQLite)
 * database — the same mechanism tests/worker-d1.smoke.test.ts uses — not pg-mem, and not a mock.
 * It fires two `Promise.all`-concurrent HTTP requests at a lot that can only satisfy one of them,
 * and asserts the correct outcome: exactly one succeeds, the other is rejected for insufficient
 * balance, and the lot's allocated total never exceeds what was purchased.
 *
 * Honest disclosure about what this test does and does not prove: manually reverting the fix and
 * re-running this same test (including a 30-way stress variant) still produced the correct outcome
 * — `unstable_dev`'s local D1/Miniflare setup for this repository appears to process the two
 * concurrent fetches to this worker instance without actually interleaving the SELECT/INSERT pair
 * across them, so it cannot be used as empirical proof that the old two-step code would race here.
 * The real basis for trusting the fix is not this test's pass/fail by itself — it's that
 * `INSERT ... SELECT ... WHERE` is a single SQL statement, and a single statement is atomic in
 * SQLite/D1 by construction (see the `meta.changes` idiom already used elsewhere in
 * worker/index.ts, e.g. the outbox claim, for the same technique). This test still has value: it
 * pins the expected HTTP contract (201 for the winner, 409 `insufficient_mileage_balance` for the
 * loser, total allocated never exceeding the lot) so a future refactor that broke that contract
 * would be caught, even though it cannot by itself catch a reintroduced non-atomic race locally.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unstable_dev, type Unstable_DevWorker } from 'wrangler';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const WRANGLER_BIN = join(REPO_ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

const SMOKE_VARS = {
  TOKEN_PEPPER: 'smoke-token-pepper-at-least-32-characters-long',
  RATE_LIMIT_SECRET: 'smoke-rate-limit-secret-at-least-32-characters',
  RESEND_API_KEY: 'unused-in-capture-mode',
  MASTER_BOOTSTRAP_TOKEN: 'smoke-bootstrap-token-long-enough-000000',
  NOTIFICATIONS_CRON_TOKEN: 'smoke-cron-token-long-enough-for-tests-0',
  EMAIL_MODE: 'capture',
};

function runWrangler(args: string[]) {
  try {
    return execFileSync(process.execPath, [WRANGLER_BIN, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout ?? '';
    const stderr = (error as { stderr?: string }).stderr ?? '';
    throw new Error(`wrangler ${args.join(' ')} failed.\nstdout: ${stdout}\nstderr: ${stderr}`);
  }
}

function d1Query<T = Record<string, unknown>>(persistTo: string, sql: string): T[] {
  const output = runWrangler(['d1', 'execute', 'DB', '--local', '--persist-to', persistTo, '--config', 'wrangler.jsonc', '--json', '--command', sql]);
  const parsed = JSON.parse(output) as Array<{ results: T[] }>;
  return parsed[0]?.results ?? [];
}

interface FetchResponseLike {
  headers: { getSetCookie?: () => string[] };
}

function setCookiesOf(response: FetchResponseLike): string[] {
  return typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
}

/** Minimal cookie jar for driving the worker's real session-cookie auth over plain fetch — copied
 * from tests/worker-d1.smoke.test.ts to keep this file independently runnable. */
class CookieJar {
  private cookies = new Map<string, string>();

  absorb(response: FetchResponseLike) {
    for (const line of setCookiesOf(response)) {
      const [pair] = line.split(';');
      const [name, ...rest] = pair!.split('=');
      if (name) this.cookies.set(name.trim(), rest.join('='));
    }
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  mutationHeaders() {
    return {
      'content-type': 'application/json',
      cookie: this.cookieHeader(),
      'x-csrf-token': this.cookies.get('rc_csrf') ?? '',
      origin: 'https://rotacertapassagens.com',
    };
  }
}

/** Same deterministic-code trick as tests/worker-d1.smoke.test.ts's recoverInviteCode: rewrites
 * the invite token's HMAC digest to a known code, since EMAIL_MODE=capture never stores plaintext. */
async function bootstrapMasterCode(persistTo: string, email: string): Promise<string> {
  const code = '111111';
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(SMOKE_VARS.TOKEN_PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(code));
  const tokenHash = [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
  runWrangler([
    'd1', 'execute', 'DB', '--local', '--persist-to', persistTo, '--config', 'wrangler.jsonc', '--json', '--command',
    `UPDATE account_tokens SET token_hash='${tokenHash}' WHERE id=(SELECT t.id FROM account_tokens t JOIN users u ON u.id=t.user_id WHERE u.email='${email}' AND t.purpose='master_invite' AND t.used_at IS NULL ORDER BY t.created_at DESC LIMIT 1)`,
  ]);
  const confirmed = d1Query<{ id: string }>(persistTo, `SELECT t.id FROM account_tokens t JOIN users u ON u.id=t.user_id WHERE u.email='${email}' AND t.purpose='master_invite' AND t.used_at IS NULL AND t.token_hash='${tokenHash}'`);
  if (!confirmed.length) throw new Error(`no master_invite token found for ${email} to rewrite`);
  return code;
}

describe('Financeiro — alocação de milhas no Worker/D1 sob concorrência real (duas abas)', () => {
  let persistTo: string;
  let worker: Unstable_DevWorker;

  beforeAll(async () => {
    persistTo = mkdtempSync(join(tmpdir(), 'rota-certa-mileage-race-'));
    runWrangler(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persistTo, '--config', 'wrangler.jsonc']);
    worker = await unstable_dev('worker/index.ts', {
      config: 'wrangler.jsonc',
      local: true,
      persistTo,
      vars: SMOKE_VARS,
      logLevel: 'error',
      experimental: { disableExperimentalWarning: true },
    });
  }, 60_000);

  afterAll(async () => {
    if (worker) await worker.stop();
    if (persistTo) rmSync(persistTo, { recursive: true, force: true });
  });

  it('duas alocações simultâneas pela última milha disponível: exatamente uma ganha, o lote nunca sobrealoca', async () => {
    const masterEmail = 'race-master@example.com';
    const bootstrap = await worker.fetch('/api/admin/bootstrap/master-invites', {
      method: 'POST',
      headers: { authorization: `Bearer ${SMOKE_VARS.MASTER_BOOTSTRAP_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email: masterEmail, name: 'Master Race' }),
    });
    expect(bootstrap.status, await bootstrap.clone().text()).toBe(201);
    const code = await bootstrapMasterCode(persistTo, masterEmail);
    const password = 'SenhaMasterRace123';
    const accept = await worker.fetch('/api/admin/master-invites/accept', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: masterEmail, code, password }),
    });
    expect(accept.status, await accept.clone().text()).toBe(200);
    const login = await worker.fetch('/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: masterEmail, password }),
    });
    expect(login.status, await login.clone().text()).toBe(200);
    const master = new CookieJar();
    master.absorb(login);

    // --- pré-requisitos financeiros: fornecedor de milhas + categoria de custo direto ---------
    const counterparty = await worker.fetch('/api/admin/finance/counterparties', {
      method: 'POST', headers: master.mutationHeaders(),
      body: JSON.stringify({ displayName: 'Fornecedor de Milhas Race', kind: 'mileage_provider' }),
    });
    expect(counterparty.status, await counterparty.clone().text()).toBe(201);
    const counterpartyId = (await counterparty.json() as { id: string }).id;

    const category = await worker.fetch('/api/admin/finance/categories', {
      method: 'POST', headers: master.mutationHeaders(),
      body: JSON.stringify({ kind: 'direct_cost', name: 'Compra de milhas (race test)' }),
    });
    expect(category.status, await category.clone().text()).toBe(201);
    const categoryId = (await category.json() as { id: string }).id;

    // --- lote com só 1000 milhas: duas requisições de 600 cada não podem as duas caber --------
    const lot = await worker.fetch('/api/admin/finance/mileage-lots', {
      method: 'POST', headers: master.mutationHeaders(),
      body: JSON.stringify({
        counterpartyId, program: 'Smiles', quantityPurchased: 1000, totalCostCents: 1000,
        currency: 'EUR', purchasedAt: '2026-01-01', dueDate: '2026-01-10', categoryId,
      }),
    });
    expect(lot.status, await lot.clone().text()).toBe(201);
    const lotId = (await lot.json() as { id: string }).id;

    // --- proposta -> conversão -> venda -> emissão em milhas -----------------------------------
    const lead = await worker.fetch('/api/lead', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'quote', name: 'Cliente Race', email: 'cliente-race@example.com', phone: '+351 912 345 678',
        origem: 'Lisboa', destino: 'Recife', ida: '2026-11-10', volta: '2026-11-25', adults: 2,
        children: 0, infants: 0, tipo: 'Ida e volta', cabinClass: 'Econômica', baggage: 'Bagagem despachada',
        flexibility: 'Até 3 dias', paymentPreference: 'Milhas', observacoes: '', contactConsent: true,
      }),
    });
    expect(lead.status, await lead.clone().text()).toBe(201);
    const protocol = (await lead.json() as { protocol: string }).protocol;
    const leadRow = d1Query<{ id: string }>(persistTo, `SELECT id FROM lead_requests WHERE protocol='${protocol}'`);
    const leadId = leadRow[0]!.id;

    const convert = await worker.fetch(`/api/admin/leads/${leadId}`, {
      method: 'PATCH', headers: master.mutationHeaders(),
      body: JSON.stringify({ status: 'converted', saleAmountCents: 200000, saleCurrency: 'EUR' }),
    });
    expect(convert.status, await convert.clone().text()).toBe(200);

    const sale = await worker.fetch(`/api/admin/finance/sales/from-lead/${leadId}`, {
      method: 'POST', headers: master.mutationHeaders(), body: JSON.stringify({}),
    });
    expect(sale.status, await sale.clone().text()).toBe(201);
    const saleId = (await sale.json() as { id: string }).id;

    const issuance = await worker.fetch(`/api/admin/finance/sales/${saleId}/issuances`, {
      method: 'POST', headers: master.mutationHeaders(),
      body: JSON.stringify({ mode: 'miles', currency: 'EUR' }),
    });
    expect(issuance.status, await issuance.clone().text()).toBe(201);
    const issuanceId = (await issuance.json() as { id: string }).id;

    // --- a corrida real: duas requisições concorrentes, cada uma pedindo 600 de um lote de 1000
    const allocate = () => worker.fetch(`/api/admin/finance/issuances/${issuanceId}/mileage-allocations`, {
      method: 'POST', headers: master.mutationHeaders(),
      body: JSON.stringify({ lotId, quantity: 600 }),
    });
    const [responseA, responseB] = await Promise.all([allocate(), allocate()]);
    const [statusA, statusB] = [responseA.status, responseB.status].sort();

    // A prova central: uma teve que ganhar (201) e a outra tinha que ser rejeitada por saldo
    // insuficiente (409) — nunca as duas 201, que é exatamente o que acontecia antes do fix.
    expect(statusA).toBe(201);
    expect(statusB).toBe(409);

    const totalAllocated = d1Query<{ n: number }>(persistTo, `SELECT COALESCE(sum(quantity),0) n FROM fin_mileage_allocations WHERE lot_id='${lotId}' AND voided_at IS NULL`);
    expect(totalAllocated[0]?.n).toBe(600);

    const lotRow = d1Query<{ quantity_purchased: number }>(persistTo, `SELECT quantity_purchased FROM fin_mileage_lots WHERE id='${lotId}'`);
    expect(totalAllocated[0]!.n).toBeLessThanOrEqual(lotRow[0]!.quantity_purchased);
  }, 60_000);
});
