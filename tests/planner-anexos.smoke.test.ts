/**
 * Planner: código e link da reserva no roteiro e anexos (PDF ou foto) por item. Worker real + D1 local
 * isolado, no mesmo molde de tests/blog-worker.smoke.test.ts.
 *
 * Cobre: reserva ao criar e ao editar, link só http(s), upload com CSRF, tipo pelo conteúdo (SVG com
 * nome .pdf é recusado), limite de tamanho e de quantidade por item, download só para o dono (outra
 * conta recebe 404), exclusão do anexo e exclusão em cascata junto com o item.
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
const VARS = {
  TOKEN_PEPPER: 'planner-smoke-token-pepper-at-least-32-chars',
  RATE_LIMIT_SECRET: 'planner-smoke-rate-limit-secret-32-characters',
  RESEND_API_KEY: 'unused-in-capture-mode',
  MASTER_BOOTSTRAP_TOKEN: 'planner-smoke-bootstrap-token-long-enough-00',
  EMAIL_MODE: 'capture',
};
const ORIGIN = 'https://rotacertapassagens.com';

function runWrangler(args: string[]) {
  try {
    return execFileSync(process.execPath, [WRANGLER_BIN, ...args], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    throw new Error(`wrangler ${args.join(' ')} failed.\nstdout: ${(error as { stdout?: string }).stdout ?? ''}\nstderr: ${(error as { stderr?: string }).stderr ?? ''}`);
  }
}
/** Grava um código conhecido no convite master (o hash guardado é de mão única). */
async function knownInviteCode(persistTo: string, email: string, code: string) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(VARS.TOKEN_PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const hash = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(code)))].map((b) => b.toString(16).padStart(2, '0')).join('');
  runWrangler(['d1', 'execute', 'DB', '--local', '--persist-to', persistTo, '--config', 'wrangler.jsonc', '--json', '--command',
    `UPDATE account_tokens SET token_hash='${hash}' WHERE id=(SELECT t.id FROM account_tokens t JOIN users u ON u.id=t.user_id WHERE u.email='${email}' AND t.purpose='master_invite' AND t.used_at IS NULL ORDER BY t.created_at DESC LIMIT 1)`]);
  return code;
}
/** Corpo multipart montado na mão: o fetch do unstable_dev não serializa o FormData do Node. */
function multipart(fields: Record<string, string | { filename: string; type: string; bytes: Uint8Array }>) {
  const boundary = `----rotacerta${Math.random().toString(16).slice(2)}`;
  const enc = new TextEncoder();
  const CRLF = '\r\n';
  const chunks: Uint8Array[] = [];
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value === 'string') {
      chunks.push(enc.encode(`--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`));
      continue;
    }
    chunks.push(
      enc.encode(`--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"; filename="${value.filename}"${CRLF}Content-Type: ${value.type}${CRLF}${CRLF}`),
      value.bytes,
      enc.encode(CRLF),
    );
  }
  chunks.push(enc.encode(`--${boundary}--${CRLF}`));
  const body = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) { body.set(c, offset); offset += c.length; }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
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

const enc = new TextEncoder();
const pdfBytes = (extra = 0) => {
  const head = enc.encode('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
  const out = new Uint8Array(head.length + extra);
  out.set(head);
  return out;
};

describe('Planner: reserva e anexos no roteiro (Worker + D1 local)', () => {
  let persistTo: string;
  let worker: Unstable_DevWorker;

  beforeAll(async () => {
    persistTo = mkdtempSync(join(tmpdir(), 'rota-certa-planner-smoke-'));
    runWrangler(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persistTo, '--config', 'wrangler.jsonc']);
    worker = await unstable_dev('worker/index.ts', { config: 'wrangler.jsonc', local: true, persistTo, vars: VARS, logLevel: 'error', experimental: { disableExperimentalWarning: true } });
  }, 60_000);

  afterAll(async () => {
    if (worker) await worker.stop();
    if (persistTo) rmSync(persistTo, { recursive: true, force: true });
  });

  async function login(email: string, senha: string) {
    const res = await worker.fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: senha }) });
    expect(res.status).toBe(200);
    const jar = new CookieJar();
    jar.absorb(res);
    return jar;
  }

  it('guarda reserva e anexos só para o dono e apaga tudo junto com o item', async () => {
    // --- duas contas: A (master inicial) e B (convidada por A) ------------------------------------
    const emailA = 'planner-a@example.com';
    const emailB = 'planner-b@example.com';
    const senha = 'SenhaPlanner123';
    expect((await worker.fetch('/api/admin/bootstrap/master-invites', { method: 'POST', headers: { authorization: `Bearer ${VARS.MASTER_BOOTSTRAP_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ email: emailA, name: 'Conta A' }) })).status).toBe(201);
    const codeA = await knownInviteCode(persistTo, emailA, '414141');
    expect((await worker.fetch('/api/admin/master-invites/accept', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: emailA, code: codeA, password: senha }) })).status).toBe(200);
    const a = await login(emailA, senha);
    expect((await worker.fetch('/api/admin/master-invites', { method: 'POST', headers: a.json(), body: JSON.stringify({ email: emailB, name: 'Conta B' }) })).status).toBe(201);
    const codeB = await knownInviteCode(persistTo, emailB, '525252');
    expect((await worker.fetch('/api/admin/master-invites/accept', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: emailB, code: codeB, password: senha }) })).status).toBe(200);
    const b = await login(emailB, senha);

    const plannerA = await worker.fetch('/api/planner', { headers: { cookie: a.cookieHeader() } }).then((r) => r.json()) as { trip: { id: string } };
    const trip = plannerA.trip.id;

    // --- reserva ao criar: link só http(s) -------------------------------------------------------
    const invalido = await worker.fetch(`/api/planner/${trip}/itinerary`, { method: 'POST', headers: a.json(), body: JSON.stringify({ day: 1, title: 'Voo', kind: 'Voo', bookingUrl: 'javascript:alert(1)' }) });
    expect(invalido.status).toBe(400);
    expect(await invalido.json()).toEqual({ error: 'invalid_booking_url' });
    const criado = await worker.fetch(`/api/planner/${trip}/itinerary`, { method: 'POST', headers: a.json(), body: JSON.stringify({ day: 1, time: '10:30', title: 'Voo para Lisboa', kind: 'Voo', bookingCode: 'K7QX2M', bookingUrl: 'https://example.com/reserva' }) });
    expect(criado.status).toBe(201);
    const { id: item } = await criado.json() as { id: string };

    // --- edição parcial: só o código muda, o resto fica -------------------------------------------
    expect((await worker.fetch(`/api/planner/${trip}/itinerary/${item}`, { method: 'PATCH', headers: a.json(), body: JSON.stringify({ bookingCode: 'ZZ9999' }) })).status).toBe(200);
    expect((await worker.fetch(`/api/planner/${trip}/itinerary/${item}`, { method: 'PATCH', headers: a.json(), body: JSON.stringify({ title: '' }) })).status).toBe(400);
    expect((await worker.fetch(`/api/planner/${trip}/itinerary/${item}`, { method: 'PATCH', headers: b.json(), body: JSON.stringify({ bookingCode: 'INVASOR' }) })).status).toBe(404);
    const depois = await worker.fetch('/api/planner', { headers: { cookie: a.cookieHeader() } }).then((r) => r.json()) as { itinerary: Array<{ id: string; title: string; booking_code: string; booking_url: string }>; attachments: unknown[] };
    const salvo = depois.itinerary.find((x) => x.id === item)!;
    expect(salvo).toMatchObject({ title: 'Voo para Lisboa', booking_code: 'ZZ9999', booking_url: 'https://example.com/reserva' });
    expect(depois.attachments).toEqual([]);

    // --- upload: precisa de CSRF, tipo pelo conteúdo, limite de tamanho ------------------------------
    const upload = (jar: CookieJar, bytes: Uint8Array, filename: string, type: string, headers?: Record<string, string>) => {
      const { body, contentType } = multipart({ file: { filename, type, bytes }, name: filename });
      return worker.fetch(`/api/planner/${trip}/itinerary/${item}/attachments`, { method: 'POST', headers: { ...(headers ?? jar.bare()), 'content-type': contentType }, body });
    };
    expect((await upload(a, pdfBytes(), 'bilhete.pdf', 'application/pdf', { cookie: a.cookieHeader(), origin: ORIGIN })).status).toBe(401);
    const svg = await upload(a, enc.encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'bilhete.pdf', 'application/pdf');
    expect(svg.status).toBe(415);
    expect((await upload(a, pdfBytes(1_450_000), 'grande.pdf', 'application/pdf')).status).toBe(413);
    const primeiro = await upload(a, pdfBytes(), 'cartão de embarque.pdf', 'application/pdf');
    expect(primeiro.status).toBe(201);
    const anexo = await primeiro.json() as { id: string; name: string; contentType: string; size: number };
    expect(anexo).toMatchObject({ name: 'cartão de embarque.pdf', contentType: 'application/pdf' });
    expect((await upload(b, pdfBytes(), 'dela.pdf', 'application/pdf')).status).toBe(404);

    // --- download: só o dono, com cabeçalhos seguros -------------------------------------------
    const baixar = await worker.fetch(`/api/planner/${trip}/attachments/${anexo.id}`, { headers: { cookie: a.cookieHeader() } });
    expect(baixar.status).toBe(200);
    expect(baixar.headers.get('content-type')).toBe('application/pdf');
    expect(baixar.headers.get('cache-control')).toBe('private, no-store');
    expect(baixar.headers.get('content-disposition')).toBe("inline; filename*=UTF-8''cart%C3%A3o%20de%20embarque.pdf");
    expect(baixar.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new TextDecoder().decode(new Uint8Array(await baixar.arrayBuffer())).startsWith('%PDF-1.4')).toBe(true);
    expect((await worker.fetch(`/api/planner/${trip}/attachments/${anexo.id}`)).status).toBe(401);
    expect((await worker.fetch(`/api/planner/${trip}/attachments/${anexo.id}`, { headers: { cookie: b.cookieHeader() } })).status).toBe(404);
    expect((await worker.fetch(`/api/planner/${trip}/attachments/${anexo.id}`, { method: 'DELETE', headers: b.bare() })).status).toBe(404);

    // --- limite de 5 anexos por item -------------------------------------------------------------
    for (let i = 2; i <= 5; i += 1) expect((await upload(a, pdfBytes(), `anexo-${i}.pdf`, 'application/pdf')).status).toBe(201);
    const sexto = await upload(a, pdfBytes(), 'anexo-6.pdf', 'application/pdf');
    expect(sexto.status).toBe(409);
    expect(await sexto.json()).toEqual({ error: 'attachment_item_limit' });
    const lista = await worker.fetch('/api/planner', { headers: { cookie: a.cookieHeader() } }).then((r) => r.json()) as { attachments: Array<{ id: string; item_id: string; data?: string }> };
    expect(lista.attachments).toHaveLength(5);
    expect(lista.attachments.every((x) => x.item_id === item && x.data === undefined)).toBe(true);

    // --- excluir um anexo e depois o item (os outros anexos vão junto) --------------------------------
    expect((await worker.fetch(`/api/planner/${trip}/attachments/${anexo.id}`, { method: 'DELETE', headers: a.bare() })).status).toBe(200);
    expect((await worker.fetch(`/api/planner/${trip}/attachments/${anexo.id}`, { headers: { cookie: a.cookieHeader() } })).status).toBe(404);
    const restante = lista.attachments.find((x) => x.id !== anexo.id)!;
    expect((await worker.fetch(`/api/planner/${trip}/itinerary/${item}`, { method: 'DELETE', headers: a.bare() })).status).toBe(200);
    expect((await worker.fetch(`/api/planner/${trip}/attachments/${restante.id}`, { headers: { cookie: a.cookieHeader() } })).status).toBe(404);
    const final = await worker.fetch('/api/planner', { headers: { cookie: a.cookieHeader() } }).then((r) => r.json()) as { attachments: unknown[] };
    expect(final.attachments).toEqual([]);
  }, 120_000);
});
