/**
 * Real Worker + real D1 smoke test — item #5 of the pre-staging review.
 *
 * Everything before this file only ever type-checked worker/index.ts (`pnpm worker:typecheck`);
 * nothing actually *ran* it. This test boots the real Cloudflare Worker (worker/index.ts, via
 * wrangler's official `unstable_dev` local-dev API — the same local Workers runtime `wrangler
 * dev` uses, Miniflare — no real Cloudflare account, no network egress) against a real D1
 * (SQLite) database that is:
 *   - created from scratch by applying the real D1 migrations in d1/migrations/ (the official
 *     `wrangler d1 migrations apply DB --local` mechanism, the same one `pnpm d1:migrate:local`
 *     uses);
 *   - fully isolated in its own temp directory (`--persist-to <tmp>`), so this test can never
 *     touch this machine's own persistent local D1 state (`.wrangler/state`) or any remote D1
 *     database. The temp directory is removed again in `afterAll`.
 *
 * EMAIL_MODE stays 'capture' throughout (the default — see wrangler.jsonc and worker/index.ts's
 * sendEmail), so nothing here ever makes a real network call to Resend or any other provider.
 * WHATSAPP_NOTIFICATIONS_ENABLED stays 'false'. No real secret is used — every "secret" below is
 * a throwaway value that only exists for the lifetime of this local, isolated D1/worker pair.
 *
 * Covers, in order, the checklist from the task spec:
 *   1. apply D1 migrations from scratch
 *   2. create master/partner
 *   3. accept invite
 *   4. open /i/{code}
 *   5. send an attributed proposal
 *   6. convert it and create a commission
 *   7. process the outbox in EMAIL_MODE=capture
 *   8. generate the weekly summary in BRL and confirm the correct value/currency
 *   9. deactivate the partner and get 403
 *  10. two concurrent claim attempts never process the same row twice
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

/** Reads a D1 row set directly (bypassing HTTP) for assertions the worker's own API surface
 * cannot answer in EMAIL_MODE=capture (e.g. the exact outbox payload written for a weekly
 * summary) — capture mode intentionally stores no message content, only a hash, in email_events. */
function d1Query<T = Record<string, unknown>>(persistTo: string, sql: string): T[] {
  const output = runWrangler(['d1', 'execute', 'DB', '--local', '--persist-to', persistTo, '--config', 'wrangler.jsonc', '--json', '--command', sql]);
  const parsed = JSON.parse(output) as Array<{ results: T[] }>;
  return parsed[0]?.results ?? [];
}

function extractCode(html: string): string {
  const match = /<strong>(\d{6})<\/strong>/.exec(html);
  if (!match) throw new Error(`no 6-digit code found in: ${html}`);
  return match[1]!;
}

describe('Worker + D1 (local, isolated): full smoke chain', () => {
  let persistTo: string;
  let worker: Unstable_DevWorker;

  beforeAll(async () => {
    persistTo = mkdtempSync(join(tmpdir(), 'rota-certa-worker-smoke-'));

    // 1. Apply D1 migrations from scratch, against this test's own isolated persist directory —
    // never the developer's real local D1 state, never remote.
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

  it('runs the full checklist: master/partner setup, invite, click, proposal, conversion, outbox, weekly BRL summary, deactivation, concurrent claim', async () => {
    const health = await worker.fetch('/api/health');
    expect(health.headers.get('strict-transport-security')).toContain('max-age=31536000');
    expect(health.headers.get('x-content-type-options')).toBe('nosniff');
    expect(health.headers.get('x-frame-options')).toBe('DENY');
    const publicPage = await worker.fetch('/parceiros');
    expect(publicPage.status).toBe(200);
    expect(publicPage.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(publicPage.headers.get('strict-transport-security')).toContain('max-age=31536000');
    const publicProgram = await worker.fetch('/api/partner-program/settings');
    expect(publicProgram.status).toBe(200);
    expect((await publicProgram.json() as { settings: { mode: string; tier1Bps: number } }).settings).toEqual(expect.objectContaining({ mode: 'progressive', tier1Bps: 200 }));

    // --- 2. create master/partner ---------------------------------------------------------
    const masterEmail = 'smoke-master@example.com';
    const bootstrap = await worker.fetch('/api/admin/bootstrap/master-invites', {
      method: 'POST',
      headers: { authorization: `Bearer ${SMOKE_VARS.MASTER_BOOTSTRAP_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email: masterEmail, name: 'Master Smoke' }),
    });
    expect(bootstrap.status).toBe(201);
    const masterInviteRow = d1Query<{ id: string }>(persistTo, `SELECT t.id FROM account_tokens t JOIN users u ON u.id=t.user_id WHERE u.email='${masterEmail}' AND t.purpose='master_invite' ORDER BY t.created_at DESC LIMIT 1`);
    expect(masterInviteRow.length).toBe(1);

    const masterCookieJar = new CookieJar();
    const masterCode = await bootstrapMasterCode(worker, persistTo, masterEmail);
    const masterPassword = 'SenhaMasterSmoke123';
    const acceptMaster = await worker.fetch('/api/admin/master-invites/accept', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: masterEmail, code: masterCode, password: masterPassword }),
    });
    expect(acceptMaster.status, await acceptMaster.clone().text()).toBe(200);

    const masterLogin = await worker.fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: masterEmail, password: masterPassword }),
    });
    expect(masterLogin.status, await masterLogin.clone().text()).toBe(200);
    masterCookieJar.absorb(masterLogin);

    const partnerCode = 'smoke-brl-partner';
    const partnerEmail = 'smoke-partner@example.com';
    const application = await worker.fetch('/api/partner-applications', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: 'Parceiro Smoke BRL', email: partnerEmail, instagram: '@smokebrl',
        whatsapp: '+55 11 91234-5678', privacyConsent: true, privacyPolicyVersion: '2026-09-24',
      }),
    });
    expect(application.status, await application.clone().text()).toBe(201);
    const applications = await worker.fetch('/api/admin/partner-applications', { headers: { cookie: masterCookieJar.cookieHeader() } });
    expect(applications.status, await applications.clone().text()).toBe(200);
    const applicationId = ((await applications.json() as { applications: Array<{ id: string; email: string }> }).applications.find((row) => row.email === partnerEmail))?.id;
    expect(applicationId).toBeTruthy();
    const createPartner = await worker.fetch('/api/admin/partners', {
      method: 'POST',
      headers: masterCookieJar.mutationHeaders(),
      body: JSON.stringify({
        applicationId, code: partnerCode, displayName: 'Parceiro Smoke BRL', email: partnerEmail,
        commissionType: 'fixed', commissionFixedCents: 4000, currency: 'BRL',
      }),
    });
    expect(createPartner.status, await createPartner.clone().text()).toBe(201);
    const partnerId = (await createPartner.json() as { id: string }).id;
    const acceptedApplication = d1Query<{ status: string; partner_id: string }>(persistTo, `SELECT status,partner_id FROM partner_applications WHERE id='${applicationId}'`);
    expect(acceptedApplication[0]).toEqual({ status: 'accepted', partner_id: partnerId });

    // --- 3. accept invite -------------------------------------------------------------------
    const invite = await worker.fetch(`/api/admin/partners/${partnerId}/invite`, { method: 'POST', headers: masterCookieJar.mutationHeaders() });
    expect(invite.status, await invite.clone().text()).toBe(201);
    const partnerInviteToken = d1Query<{ id: string }>(persistTo, `SELECT t.id FROM account_tokens t JOIN users u ON u.id=t.user_id WHERE u.email='${partnerEmail}' AND t.purpose='partner_invite' ORDER BY t.created_at DESC LIMIT 1`);
    expect(partnerInviteToken.length).toBe(1);
    const partnerCodeInput = await recoverInviteCode(worker, persistTo, partnerEmail, 'partner_invite', '222222');
    const partnerPassword = 'SenhaParceiroSmoke123';
    const acceptPartner = await worker.fetch('/api/partner-invites/accept', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: partnerEmail, code: partnerCodeInput, password: partnerPassword }),
    });
    expect(acceptPartner.status, await acceptPartner.clone().text()).toBe(200);

    const partnerCookieJar = new CookieJar();
    const partnerLogin = await worker.fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: partnerEmail, password: partnerPassword }),
    });
    expect(partnerLogin.status).toBe(200);
    partnerCookieJar.absorb(partnerLogin);

    // --- 4. open /i/{code} -------------------------------------------------------------------
    const click = await worker.fetch(`/i/${partnerCode}`, { redirect: 'manual' });
    expect(click.status).toBe(302);
    const refCookie = CookieJar.extractCookie(click, 'rc_ref');
    expect(refCookie).toBeTruthy();

    // --- 5. send an attributed proposal --------------------------------------------------
    const buyerEmail = 'smoke-buyer@example.com';
    const lead = await worker.fetch('/api/lead', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `rc_ref=${refCookie}` },
      body: JSON.stringify({
        type: 'quote', name: 'Comprador Smoke', email: buyerEmail, phone: '+55 11 91234-5678',
        origem: 'São Paulo', destino: 'Lisboa', ida: '2027-04-10', volta: '2027-04-20', adults: 1,
        children: 0, infants: 0, tipo: 'Ida e volta', cabinClass: 'Econômica', baggage: 'Bagagem despachada',
        flexibility: 'Datas fixas', paymentPreference: 'Dinheiro', observacoes: '', contactConsent: true,
      }),
    });
    expect(lead.status, await lead.clone().text()).toBe(201);
    const protocol = (await lead.json() as { protocol: string }).protocol;
    const leadRow = d1Query<{ id: string; partner_id: string }>(persistTo, `SELECT id,partner_id FROM lead_requests WHERE protocol='${protocol}'`);
    expect(leadRow[0]?.partner_id).toBe(partnerId);
    const leadId = leadRow[0]!.id;

    // --- 6. convert it and create a commission -----------------------------------------------
    const convert = await worker.fetch(`/api/admin/leads/${leadId}`, {
      method: 'PATCH',
      headers: masterCookieJar.mutationHeaders(),
      body: JSON.stringify({ status: 'converted', saleAmountCents: 200000, saleCurrency: 'BRL' }),
    });
    expect(convert.status, await convert.clone().text()).toBe(200);
    const commissionPreview = (await convert.json() as { commissionPreview: { amountCents: number; currency: string } }).commissionPreview;
    expect(commissionPreview).toEqual({ amountCents: 4000, currency: 'BRL' });

    // --- 7. process the outbox in EMAIL_MODE=capture -----------------------------------------
    const processed = await worker.fetch('/api/admin/notifications/process', {
      method: 'POST',
      headers: masterCookieJar.mutationHeaders(),
      body: JSON.stringify({ limit: 50 }),
    });
    expect(processed.status, await processed.clone().text()).toBe(200);
    const processedBody = await processed.json() as { sent: number; failed: number };
    expect(processedBody.sent).toBeGreaterThanOrEqual(1);
    expect(processedBody.failed).toBe(0);
    // Real proof that EMAIL_MODE=capture ran (real D1 write, no network): email_events has a row
    // with provider='local-capture', never 'resend'.
    const emailEvents = d1Query<{ provider: string; status: string }>(persistTo, "SELECT provider,status FROM email_events WHERE provider='local-capture'");
    expect(emailEvents.length).toBeGreaterThanOrEqual(1);
    expect(emailEvents.every((row) => row.status === 'captured')).toBe(true);
    const resendEvents = d1Query(persistTo, "SELECT 1 FROM email_events WHERE provider='resend'");
    expect(resendEvents.length).toBe(0);

    // --- 8. generate the weekly summary in BRL and confirm value/currency --------------------
    const weekly = await worker.fetch('/api/admin/notifications/weekly-summary', { method: 'POST', headers: masterCookieJar.mutationHeaders() });
    expect(weekly.status, await weekly.clone().text()).toBe(200);
    expect((await weekly.json() as { summariesCreated: number }).summariesCreated).toBeGreaterThanOrEqual(1);
    const weeklyRows = d1Query<{ payload: string }>(persistTo, `SELECT payload FROM notification_outbox WHERE event_type='weekly_summary' AND partner_id='${partnerId}'`);
    expect(weeklyRows.length).toBe(1);
    const weeklyPayload = JSON.parse(weeklyRows[0]!.payload) as { commissionCents: number; currency: string };
    expect(weeklyPayload).toEqual(expect.objectContaining({ commissionCents: 4000, currency: 'BRL' }));

    const processWeekly = await worker.fetch('/api/admin/notifications/process', { method: 'POST', headers: masterCookieJar.mutationHeaders(), body: JSON.stringify({ limit: 50 }) });
    expect(processWeekly.status).toBe(200);
    expect((await processWeekly.json() as { failed: number }).failed).toBe(0);

    // --- 9. deactivate the partner and get 403 -----------------------------------------------
    const deactivate = await worker.fetch(`/api/admin/partners/${partnerId}`, { method: 'PATCH', headers: masterCookieJar.mutationHeaders(), body: JSON.stringify({ active: false }) });
    expect(deactivate.status, await deactivate.clone().text()).toBe(200);
    const blockedSummary = await worker.fetch('/api/partner/summary', { headers: { cookie: partnerCookieJar.cookieHeader() } });
    expect(blockedSummary.status).toBe(403);

    // --- 10. two concurrent claim attempts never process the same row twice ------------------
    const reactivate = await worker.fetch(`/api/admin/partners/${partnerId}`, { method: 'PATCH', headers: masterCookieJar.mutationHeaders(), body: JSON.stringify({ active: true }) });
    expect(reactivate.status).toBe(200);
    const secondLead = await worker.fetch('/api/lead', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `rc_ref=${refCookie}` },
      body: JSON.stringify({
        type: 'quote', name: 'Comprador Smoke 2', email: 'smoke-buyer-2@example.com', phone: '+55 11 98888-7777',
        origem: 'Rio de Janeiro', destino: 'Porto', ida: '2027-05-01', volta: '2027-05-15', adults: 1,
        children: 0, infants: 0, tipo: 'Ida e volta', cabinClass: 'Econômica', baggage: 'Bagagem despachada',
        flexibility: 'Datas fixas', paymentPreference: 'Dinheiro', observacoes: '', contactConsent: true,
      }),
    });
    expect(secondLead.status, await secondLead.clone().text()).toBe(201);
    // Scoped to this specific row: an earlier referral_confirmed row (from the first lead, step 5)
    // was already sent in step 7, so a global count would trivially include it too.
    const pendingBefore = d1Query<{ id: string }>(persistTo, "SELECT id FROM notification_outbox WHERE status='pending' AND event_type='referral_confirmed'");
    expect(pendingBefore.length).toBe(1);
    const secondLeadOutboxId = pendingBefore[0]!.id;

    const [concurrentA, concurrentB] = await Promise.all([
      worker.fetch('/api/admin/notifications/process', { method: 'POST', headers: masterCookieJar.mutationHeaders(), body: JSON.stringify({ limit: 50 }) }),
      worker.fetch('/api/admin/notifications/process', { method: 'POST', headers: masterCookieJar.mutationHeaders(), body: JSON.stringify({ limit: 50 }) }),
    ]);
    const [bodyA, bodyB] = await Promise.all([concurrentA.json() as Promise<{ sent: number }>, concurrentB.json() as Promise<{ sent: number }>]);
    // The core concurrency proof: exactly one of the two concurrent calls actually sent this row
    // — never both, never neither.
    expect(bodyA.sent + bodyB.sent).toBe(1);
    const finalRow = d1Query<{ status: string }>(persistTo, `SELECT status FROM notification_outbox WHERE id='${secondLeadOutboxId}'`);
    expect(finalRow[0]?.status).toBe('sent');
  }, 120_000);
});

/**
 * Recovers a one-time account_tokens code the same way a real user would read it from their
 * inbox — except EMAIL_MODE=capture never stores the plaintext, only a recipient hash (by
 * design: see src/email.ts / worker/index.ts's sendEmail). The worker has no test-only
 * introspection route (unlike tests/e2e/bootstrap-server.ts's Node/Fastify equivalent), so this
 * smoke test instead temporarily switches the target token's expiry/attempt bookkeeping via a
 * direct D1 write to make a controlled, test-only code deterministic and readable — this is
 * local-only test plumbing, not a capability the deployed Worker exposes.
 */
async function bootstrapMasterCode(worker: Unstable_DevWorker, persistTo: string, email: string): Promise<string> {
  return recoverInviteCode(worker, persistTo, email, 'master_invite', '111111');
}

async function recoverInviteCode(worker: Unstable_DevWorker, persistTo: string, email: string, purpose: string, code: string): Promise<string> {
  void worker;
  // The token is stored as an HMAC digest (token_hash), which is deliberately one-way — there is
  // no way to recover the original 6-digit code from it, by design (see worker/index.ts's
  // `digest()`). To keep this a genuine black-box HTTP smoke test without adding a
  // production-only introspection endpoint, this helper issues its own known code and rewrites
  // token_hash to match it, using the exact same HMAC-SHA256 construction the worker itself uses
  // (`digest(value, env)` in worker/index.ts), with the same TOKEN_PEPPER this test configured.
  // Each caller passes a distinct code: token_hash has a UNIQUE constraint (migration 0001), so
  // two different tokens can never share the same rewritten hash.
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(SMOKE_VARS.TOKEN_PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(code));
  const tokenHash = [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
  // Note: this local D1/wrangler version's `d1 execute --json` output does not populate
  // `meta.changes` for an UPDATE (only `meta.duration`), so success is verified with a follow-up
  // SELECT rather than trusting that field.
  runWrangler([
    'd1', 'execute', 'DB', '--local', '--persist-to', persistTo, '--config', 'wrangler.jsonc', '--json', '--command',
    `UPDATE account_tokens SET token_hash='${tokenHash}' WHERE id=(SELECT t.id FROM account_tokens t JOIN users u ON u.id=t.user_id WHERE u.email='${email}' AND t.purpose='${purpose}' AND t.used_at IS NULL ORDER BY t.created_at DESC LIMIT 1)`,
  ]);
  const confirmed = d1Query<{ id: string }>(persistTo, `SELECT t.id FROM account_tokens t JOIN users u ON u.id=t.user_id WHERE u.email='${email}' AND t.purpose='${purpose}' AND t.used_at IS NULL AND t.token_hash='${tokenHash}'`);
  if (!confirmed.length) throw new Error(`no ${purpose} token found for ${email} to rewrite`);
  return code;
}

/** Structural shape shared by both `worker.fetch()`'s undici Response and the global DOM
 * Response type, so this test doesn't have to fight the two slightly different lib.dom /
 * undici ReadableStream type definitions just to read Set-Cookie headers. */
interface FetchResponseLike {
  headers: { getSetCookie?: () => string[] };
}

function setCookiesOf(response: FetchResponseLike): string[] {
  return typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
}

/** Minimal cookie jar for driving the worker's real session-cookie auth over plain fetch. */
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

  static extractCookie(response: FetchResponseLike, name: string): string | null {
    for (const line of setCookiesOf(response)) {
      const [pair] = line.split(';');
      const [cookieName, ...rest] = pair!.split('=');
      if (cookieName?.trim() === name) return rest.join('=');
    }
    return null;
  }
}
