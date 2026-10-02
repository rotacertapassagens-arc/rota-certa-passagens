/**
 * Planner, ideias 3, 5, 6 e 7: moedas e câmbio, divisão de custos, link de leitura da viagem, datas
 * reais com lembrete de check-in (tarefa agendada) e voo emitido pela equipe entrando no roteiro do
 * cliente (inclusive quando ele ainda não tem conta). Worker real + D1 local isolado.
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

describe('Planner: moedas, divisão, compartilhar, datas, lembrete e voo emitido (Worker + D1 local)', () => {
  let persistTo: string;
  let worker: Unstable_DevWorker;

  beforeAll(async () => {
    persistTo = mkdtempSync(join(tmpdir(), 'rota-certa-ideias-smoke-'));
    runWrangler(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persistTo, '--config', 'wrangler.jsonc']);
    worker = await unstable_dev('worker/index.ts', { config: 'wrangler.jsonc', local: true, persistTo, vars: VARS, logLevel: 'error', experimental: { disableExperimentalWarning: true, testScheduled: true } });
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
  async function convidar(jar: CookieJar | null, email: string, code: string, senha: string) {
    const res = jar
      ? await worker.fetch('/api/admin/master-invites', { method: 'POST', headers: jar.json(), body: JSON.stringify({ email, name: email.split('@')[0] }) })
      : await worker.fetch('/api/admin/bootstrap/master-invites', { method: 'POST', headers: { authorization: `Bearer ${VARS.MASTER_BOOTSTRAP_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ email, name: 'Ana Souza' }) });
    expect(res.status).toBe(201);
    await knownInviteCode(persistTo, email, code);
    expect((await worker.fetch('/api/admin/master-invites/accept', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code, password: senha }) })).status).toBe(200);
    return login(email, senha);
  }
  const count = (sql: string) => Number(d1Query<{ n: number }>(persistTo, sql)[0]!.n);

  it('cobre as ideias 3, 5, 6 e 7 de ponta a ponta', async () => {
    const senha = 'SenhaIdeias12345';
    const a = await convidar(null, 'ana@example.com', '616161', senha);
    const planner = async (jar: CookieJar, query = '') => worker.fetch('/api/planner' + query, { headers: { cookie: jar.cookieHeader() } }).then((r) => r.json()) as Promise<Record<string, any>>;
    const trip = (await planner(a)).trip.id as string;

    // --- câmbio (fixo nos testes) ---------------------------------------------------------------
    const rates = await worker.fetch('/api/planner/rates').then((r) => r.json()) as { base: string; rates: Record<string, number> };
    expect(rates.base).toBe('EUR');
    expect(rates.rates.BRL).toBeGreaterThan(1);

    // --- ideia 5: moeda do orçamento e das despesas; ideia 6: quem pagou --------------------------------
    expect((await worker.fetch(`/api/planner/${trip}/budget`, { method: 'PUT', headers: a.json(), body: JSON.stringify({ amount: 9000, currency: 'BRL' }) })).status).toBe(200);
    expect((await worker.fetch(`/api/planner/${trip}/budget`, { method: 'PUT', headers: a.json(), body: JSON.stringify({ amount: 10, currency: 'JPY' }) })).status).toBe(400);
    expect((await worker.fetch(`/api/planner/${trip}/expenses`, { method: 'POST', headers: a.json(), body: JSON.stringify({ amount: 120, category: 'Hospedagem', description: 'Hotel', currency: 'EUR', paidBy: 'Bruno' }) })).status).toBe(201);
    expect((await worker.fetch(`/api/planner/${trip}/expenses`, { method: 'POST', headers: a.json(), body: JSON.stringify({ amount: 300, category: 'Alimentação', description: 'Jantar', currency: 'BRL' }) })).status).toBe(201);
    expect((await worker.fetch(`/api/planner/${trip}/expenses`, { method: 'POST', headers: a.json(), body: JSON.stringify({ amount: 5, category: 'Outros', description: 'x', currency: 'XYZ' }) })).status).toBe(400);

    // --- configurações: nome, datas e viajantes --------------------------------------------------------
    const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const hora = new Date(Date.now() + 86400000).toISOString().slice(11, 16);
    expect((await worker.fetch(`/api/planner/trips/${trip}`, { method: 'PATCH', headers: a.json(), body: JSON.stringify({ name: 'Lisboa com amigos', startsOn: amanha, companions: ['Bruno', 'Carla', 'Você', ''] }) })).status).toBe(200);
    expect((await worker.fetch(`/api/planner/trips/${trip}`, { method: 'PATCH', headers: a.json(), body: JSON.stringify({ startsOn: '2026-13-40' }) })).status).toBe(400);
    const depois = await planner(a);
    expect(depois.trip).toMatchObject({ name: 'Lisboa com amigos', starts_on: amanha, travelers: 3 });
    expect(JSON.parse(depois.trip.companions)).toEqual(['Bruno', 'Carla']);
    expect(depois.budget).toMatchObject({ amount_cents: 900000, currency: 'BRL' });
    expect(depois.expenses.map((e: any) => `${e.currency}:${e.paid_by ?? ''}`).sort()).toEqual(['BRL:', 'EUR:Bruno']);

    // --- ideia 7: voo com data real recebe lembrete pela tarefa agendada, uma vez só ------------------------
    const voo = await worker.fetch(`/api/planner/${trip}/itinerary`, { method: 'POST', headers: a.json(), body: JSON.stringify({ day: 1, time: hora, title: 'Voo para Lisboa', kind: 'Voo', bookingCode: 'K7QX2M' }) }).then((r) => r.json()) as { id: string };
    await worker.fetch(`/api/planner/${trip}/itinerary`, { method: 'POST', headers: a.json(), body: JSON.stringify({ day: 5, time: '10:00', title: 'Voo de volta', kind: 'Voo' }) });
    expect((await worker.fetch('/__scheduled?cron=20+*+*+*+*')).status).toBe(200);
    await new Promise((r) => setTimeout(r, 1500));
    expect(d1Query<{ id: string }>(persistTo, 'SELECT id FROM itinerary_items WHERE reminder_sent_at IS NOT NULL').map((x) => x.id)).toEqual([voo.id]);
    expect(count("SELECT count(*) n FROM email_events WHERE template='checkin_reminder'")).toBe(1);
    await worker.fetch('/__scheduled?cron=20+*+*+*+*');
    await new Promise((r) => setTimeout(r, 1000));
    expect(count("SELECT count(*) n FROM email_events WHERE template='checkin_reminder'")).toBe(1);

    // --- ideia 6: link de leitura sem código de reserva nem custos --------------------------------------
    const share = await worker.fetch(`/api/planner/trips/${trip}/share`, { method: 'POST', headers: a.bare() }).then((r) => r.json()) as { token: string; url: string };
    expect(share.url).toContain('/viagem/');
    const pagina = await worker.fetch(`/viagem/${share.token}`);
    expect(pagina.status).toBe(200);
    expect(pagina.headers.get('x-robots-tag')).toContain('noindex');
    const html = await pagina.text();
    expect(html).toContain('Lisboa com amigos');
    expect(html).toContain('Voo para Lisboa');
    expect(html).not.toContain('K7QX2M');
    expect(html).not.toContain('Hotel');
    expect((await worker.fetch(`/api/planner/trips/${trip}/share`, { method: 'DELETE', headers: a.bare() })).status).toBe(200);
    expect((await worker.fetch(`/viagem/${share.token}`)).status).toBe(404);
    // Endereço malformado cai na página padrão do site (404), sem erro 500.
    expect((await worker.fetch('/viagem/')).status).toBe(404);
    expect((await worker.fetch('/viagem/curto')).status).toBe(404);
    expect((await worker.fetch('/media/blog/nao-existe.jpg')).status).toBe(404);
    // Página 404 da marca para qualquer endereço inexistente.
    const perdida = await worker.fetch('/pagina-que-nao-existe');
    expect(perdida.status).toBe(404);
    expect(await perdida.text()).toContain('Erro 404');
    // Home com prévia de compartilhamento e dados estruturados.
    const home = await (await worker.fetch('/')).text();
    expect(home).toContain('<meta property="og:image" content="https://rotacertapassagens.com/assets/compartilhar/home.jpg">');
    expect(JSON.parse(home.match(/<script type="application\/ld\+json">(.*?)<\/script>/)?.[1] ?? '{}')['@graph'][0]['@type']).toBe('TravelAgency');

    // --- ideia 3: voo emitido entra no roteiro do cliente ---------------------------------------------
    const b = await convidar(a, 'bruno@example.com', '727272', senha);
    const lead = async (email: string) => {
      const res = await worker.fetch('/api/lead', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        type: 'quote', name: 'Cliente Teste', email, phone: '+55 11 91234-5678', origem: 'São Paulo', destino: 'Lisboa', ida: '2027-04-10', volta: '2027-04-20',
        adults: 1, children: 0, infants: 0, tipo: 'Ida e volta', cabinClass: 'Econômica', baggage: 'Bagagem despachada', flexibility: 'Datas fixas',
        paymentPreference: 'Pix', observacoes: '', contactConsent: true }) });
      expect(res.status).toBe(201);
      const protocol = (await res.json() as { protocol: string }).protocol;
      return d1Query<{ id: string }>(persistTo, `SELECT id FROM lead_requests WHERE protocol='${protocol}'`)[0]!.id;
    };
    const leadB = await lead('bruno@example.com');
    const flight = { outboundDate: '2027-04-10', outboundTime: '22:15', flightOut: 'Voo 247', returnDate: '2027-04-20', returnTime: '11:40', bookingCode: 'RC4455' };
    expect((await worker.fetch(`/api/admin/leads/${leadB}/planner-flight`, { method: 'POST', headers: a.json(), body: JSON.stringify({ outboundDate: 'x' }) })).status).toBe(400);
    const enviado = await worker.fetch(`/api/admin/leads/${leadB}/planner-flight`, { method: 'POST', headers: a.json(), body: JSON.stringify(flight) }).then((r) => r.json()) as { applied: boolean; tripId: string };
    expect(enviado.applied).toBe(true);
    const plannerB = await planner(b, `?tripId=${enviado.tripId}`);
    expect(plannerB.trip).toMatchObject({ name: 'Viagem para Lisboa', starts_on: '2027-04-10', ends_on: '2027-04-20', source: 'rota_certa' });
    expect(plannerB.itinerary.map((i: any) => `${i.day}|${i.time}|${i.booking_code}`)).toEqual(['1|22:15|RC4455', '11|11:40|RC4455']);
    expect(count("SELECT count(*) n FROM email_events WHERE template='planner_flight_added'")).toBe(1);

    // cliente sem conta: fica pendente e entra quando a conta existe (uma vez só)
    const leadC = await lead('carla@example.com');
    const pendente = await worker.fetch(`/api/admin/leads/${leadC}/planner-flight`, { method: 'POST', headers: a.json(), body: JSON.stringify(flight) }).then((r) => r.json()) as { applied: boolean };
    expect(pendente.applied).toBe(false);
    expect(count("SELECT count(*) n FROM planner_flight_imports WHERE email='carla@example.com' AND applied_at IS NULL")).toBe(1);
    const c = await convidar(a, 'carla@example.com', '838383', senha);
    await planner(c);
    const plannerC = await planner(c);
    expect(plannerC.trips.filter((t: any) => t.name === 'Viagem para Lisboa')).toHaveLength(1);
    expect(count("SELECT count(*) n FROM planner_flight_imports WHERE email='carla@example.com' AND applied_at IS NOT NULL")).toBe(1);

    // --- modelo da Tais: cliente Rota Certa com Planner até a volta, Premium pelo painel, reativação --------
    expect(count("SELECT count(*) n FROM subscriptions s JOIN plans p ON p.id=s.plan_id JOIN users u ON u.id=s.user_id WHERE u.email='bruno@example.com' AND p.code='cliente-rota-certa' AND s.ends_at LIKE '2027-04-27%'")).toBe(1);
    expect((await worker.fetch('/api/admin/subscriptions/grant', { method: 'POST', headers: a.json(), body: JSON.stringify({ email: 'ninguem@example.com', days: 30 }) })).status).toBe(404);
    const grant = await worker.fetch('/api/admin/subscriptions/grant', { method: 'POST', headers: a.json(), body: JSON.stringify({ email: 'bruno@example.com', days: 30 }) }).then((r) => r.json()) as { ok: boolean; endsAt: string };
    expect(grant.ok).toBe(true);
    expect(Date.parse(grant.endsAt.replace(' ', 'T') + 'Z') - Date.now()).toBeGreaterThan(29 * 86400000);
    expect(count("SELECT count(*) n FROM email_events WHERE template='premium_granted'")).toBe(1);
    const renova = await worker.fetch('/api/admin/subscriptions/grant', { method: 'POST', headers: a.json(), body: JSON.stringify({ email: 'bruno@example.com', days: 30 }) }).then((r) => r.json()) as { endsAt: string };
    expect(Date.parse(renova.endsAt.replace(' ', 'T') + 'Z') - Date.now()).toBeGreaterThan(59 * 86400000);

    // cliente comum com o teste vencido e viagem daqui a 7 dias recebe a reativação, uma vez só
    const emSete = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    d1Query(persistTo, `INSERT INTO users(id,email,email_verified_at,status) VALUES('u-reativa','reativa@example.com',CURRENT_TIMESTAMP,'active'),('u-ativo','ativo@example.com',CURRENT_TIMESTAMP,'active')`);
    d1Query(persistTo, `INSERT INTO profiles(user_id,display_name) VALUES('u-reativa','Rita Reativa'),('u-ativo','Ari Ativo')`);
    d1Query(persistTo, `INSERT INTO subscriptions(id,user_id,plan_id,status,starts_at,ends_at) SELECT 's-ativo','u-ativo',id,'trialing',CURRENT_TIMESTAMP,datetime('now','+5 days') FROM plans WHERE code='trial-10d'`);
    d1Query(persistTo, `INSERT INTO trips(id,owner_user_id,name,starts_on) VALUES('t-reativa','u-reativa','Paris','${emSete}'),('t-ativo','u-ativo','Roma','${emSete}')`);
    await worker.fetch('/__scheduled?cron=20+*+*+*+*');
    await new Promise((r) => setTimeout(r, 1500));
    await worker.fetch('/__scheduled?cron=20+*+*+*+*');
    await new Promise((r) => setTimeout(r, 1000));
    expect(count("SELECT count(*) n FROM email_events WHERE template='planner_reactivation'")).toBe(1);
    expect(count("SELECT count(*) n FROM trips WHERE id='t-reativa' AND reactivation_sent_at IS NOT NULL")).toBe(1);
    expect(count("SELECT count(*) n FROM trips WHERE id='t-ativo' AND reactivation_sent_at IS NOT NULL")).toBe(0);
  }, 180_000);
});
