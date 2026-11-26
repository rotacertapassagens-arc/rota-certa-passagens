/** Conta só de parceiro não acessa a API do planner; ganhando customer, volta a acessar. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unstable_dev, type Unstable_DevWorker } from 'wrangler';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const WRANGLER_BIN = join(REPO_ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const VARS = {
  TOKEN_PEPPER: 'ideias-smoke-token-pepper-at-least-32-chars',
  RATE_LIMIT_SECRET: 'ideias-smoke-rate-limit-secret-32-characters',
  RESEND_API_KEY: 'unused-in-capture-mode',
  MASTER_BOOTSTRAP_TOKEN: 'ideias-smoke-bootstrap-token-long-enough-00',
  EMAIL_MODE: 'capture',
  RATES_MODE: 'fixed',
};
const ORIGIN = 'https://rotacertapassagens.com';

function runWrangler(args: string[]) {
  try {
    return execFileSync(process.execPath, [WRANGLER_BIN, ...args], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    throw new Error(`wrangler ${args.join(' ')} failed.\nstdout: ${(error as { stdout?: string }).stdout ?? ''}\nstderr: ${(error as { stderr?: string }).stderr ?? ''}`);
  }
}
function d1Query<T = Record<string, unknown>>(persistTo: string, sql: string): T[] {
  const output = runWrangler(['d1', 'execute', 'DB', '--local', '--persist-to', persistTo, '--config', 'wrangler.jsonc', '--json', '--command', sql]);
  return (JSON.parse(output) as Array<{ results: T[] }>)[0]?.results ?? [];
}
/** Grava um código conhecido no convite master (o hash guardado é de mão única). */
async function knownInviteCode(persistTo: string, email: string, code: string) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(VARS.TOKEN_PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const hash = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(code)))].map((b) => b.toString(16).padStart(2, '0')).join('');
  runWrangler(['d1', 'execute', 'DB', '--local', '--persist-to', persistTo, '--config', 'wrangler.jsonc', '--json', '--command',
    `UPDATE account_tokens SET token_hash='${hash}' WHERE id=(SELECT t.id FROM account_tokens t JOIN users u ON u.id=t.user_id WHERE u.email='${email}' AND t.purpose='master_invite' AND t.used_at IS NULL ORDER BY t.created_at DESC LIMIT 1)`]);
}

interface FetchResponseLike { headers: { getSetCookie?: () => string[] } }
class CookieJar {
  private cookies = new Map<string, string>();
  absorb(response: FetchResponseLike) {
    const lines = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    for (const line of lines) {
      const [pair] = line.split(';');
      const [name, ...rest] = pair!.split('=');
      if (name) this.cookies.set(name.trim(), rest.join('='));
    }
  }
  cookieHeader() { return [...this.cookies.entries()].map(([n, v]) => `${n}=${v}`).join('; '); }
  csrf() { return this.cookies.get('rc_csrf') ?? ''; }
  json() { return { 'content-type': 'application/json', cookie: this.cookieHeader(), 'x-csrf-token': this.csrf(), origin: ORIGIN }; }
  bare() { return { cookie: this.cookieHeader(), 'x-csrf-token': this.csrf(), origin: ORIGIN }; }
}

describe('Planner travado para conta só de parceiro (Worker + D1 local)', () => {
  let persistTo: string;
  let worker: Unstable_DevWorker;

  beforeAll(async () => {
    persistTo = mkdtempSync(join(tmpdir(), 'rota-certa-planner-parceiro-'));
    runWrangler(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persistTo, '--config', 'wrangler.jsonc']);
    worker = await unstable_dev('worker/index.ts', { config: 'wrangler.jsonc', local: true, persistTo, vars: VARS, logLevel: 'error', experimental: { disableExperimentalWarning: true } });
  }, 240_000);

  afterAll(async () => {
    if (worker) await worker.stop();
    if (persistTo) rmSync(persistTo, { recursive: true, force: true });
  });

  it('bloqueia o planner para parceiro sem customer e libera quando ganha customer', async () => {
    const email = 'parceiro-so@example.com';
    const senha = 'SenhaParceiro12345';
    const res = await worker.fetch('/api/admin/bootstrap/master-invites', { method: 'POST', headers: { authorization: `Bearer ${VARS.MASTER_BOOTSTRAP_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ email, name: 'Parceiro Teste' }) });
    expect(res.status).toBe(201);
    await knownInviteCode(persistTo, email, '737373');
    expect((await worker.fetch('/api/admin/master-invites/accept', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code: '737373', password: senha }) })).status).toBe(200);
    const uid = `(SELECT id FROM users WHERE email='${email}')`;
    d1Query(persistTo, `DELETE FROM user_roles WHERE user_id=${uid}`);
    d1Query(persistTo, `INSERT INTO user_roles(user_id,role) VALUES(${uid},'partner')`);

    const login = await worker.fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: senha }) });
    expect(login.status).toBe(200);
    const jar = new CookieJar();
    jar.absorb(login);

    const get = await worker.fetch('/api/planner', { headers: { cookie: jar.cookieHeader() } });
    expect(get.status).toBe(403);
    expect(await get.json()).toEqual({ error: 'planner_not_allowed' });
    expect((await worker.fetch('/api/planner/trips', { method: 'POST', headers: jar.json(), body: JSON.stringify({ name: 'x' }) })).status).toBe(403);
    expect((await worker.fetch('/api/planner/rates', { headers: { cookie: jar.cookieHeader() } })).status).toBe(403);

    d1Query(persistTo, `INSERT INTO user_roles(user_id,role) VALUES(${uid},'customer')`);
    // Passou da trava: o customer sem assinatura cai no paywall normal (402), não no 403.
    expect((await worker.fetch('/api/planner', { headers: { cookie: jar.cookieHeader() } })).status).not.toBe(403);
  }, 60_000);
});
