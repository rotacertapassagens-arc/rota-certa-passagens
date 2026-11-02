/**
 * Financeiro, carteira de milhas própria: saldo e custo médio por pessoa e programa, clubes que reagem aos e-mails dos
 * programas, uso das milhas numa emissão (BRL e EUR) e a rota interna que recebe os eventos. Worker real + D1 local isolado.
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
const INTERNAL_TOKEN = 'carteira-smoke-internal-token-with-32-plus-chars';
const VARS = {
  TOKEN_PEPPER: 'carteira-smoke-token-pepper-at-least-32-chars',
  RATE_LIMIT_SECRET: 'carteira-smoke-rate-limit-secret-32-characters',
  RESEND_API_KEY: 'unused-in-capture-mode',
  MASTER_BOOTSTRAP_TOKEN: 'carteira-smoke-bootstrap-token-long-enough-0',
  ROTA_CERTA_SITE_API_TOKEN: INTERNAL_TOKEN,
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
  json() { return { 'content-type': 'application/json', cookie: this.cookieHeader(), 'x-csrf-token': this.cookies.get('rc_csrf') ?? '', origin: ORIGIN }; }
}

describe('Financeiro: carteira de milhas própria (Worker + D1 local)', () => {
  let persistTo: string;
  let worker: Unstable_DevWorker;

  beforeAll(async () => {
    persistTo = mkdtempSync(join(tmpdir(), 'rota-certa-carteira-smoke-'));
    runWrangler(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persistTo, '--config', 'wrangler.jsonc']);
    worker = await unstable_dev('worker/index.ts', { config: 'wrangler.jsonc', local: true, persistTo, vars: VARS, logLevel: 'error', experimental: { disableExperimentalWarning: true } });
  }, 60_000);

  afterAll(async () => {
    if (worker) await worker.stop();
    if (persistTo) rmSync(persistTo, { recursive: true, force: true });
  });

  async function createMasterJar() {
    const email = 'carlos@example.com';
    const senha = 'SenhaCarteira12345';
    const invite = await worker.fetch('/api/admin/bootstrap/master-invites', { method: 'POST', headers: { authorization: `Bearer ${VARS.MASTER_BOOTSTRAP_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ email, name: 'Carlos Teste' }) });
    expect(invite.status).toBe(201);
    await knownInviteCode(persistTo, email, '818181');
    expect((await worker.fetch('/api/admin/master-invites/accept', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code: '818181', password: senha }) })).status).toBe(200);
    const res = await worker.fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: senha }) });
    expect(res.status).toBe(200);
    const jar = new CookieJar();
    jar.absorb(res);
    return jar;
  }
  let masterJarPromise: Promise<CookieJar> | undefined;
  const masterJar = () => (masterJarPromise ??= createMasterJar());
  const send = async (jar: CookieJar, method: string, path: string, data?: unknown) => {
    const res = await worker.fetch(path, { method, headers: jar.json(), ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const text = await res.text();
    let json: Record<string, any> = {};
    try { json = JSON.parse(text); } catch { /* sem corpo */ }
    return { status: res.status, json };
  };
  const internal = (events: unknown[], token: string | null = INTERNAL_TOKEN) => worker.fetch('/api/internal/wallet/events', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ events }),
  });
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();

  it('saldo, custo médio, saída sem saldo, uso em emissão BRL e EUR, estorno e conferência com o programa', async () => {
    const jar = await masterJar();
    expect((await worker.fetch('/api/admin/finance/wallet')).status).toBe(403);

    const conta = await send(jar, 'POST', '/api/admin/finance/wallet/accounts', { holder: 'Carlos', program: 'LATAM Pass', memberNumber: '0633000545', cpfLimit: 24, openingMiles: 100000, openingCostCents: 245000 });
    expect(conta.status).toBe(201);
    const id = conta.json.id as string;
    expect((await send(jar, 'POST', '/api/admin/finance/wallet/accounts', { holder: 'Carlos', program: 'LATAM Pass' })).status).toBe(409);
    expect((await send(jar, 'POST', '/api/admin/finance/wallet/accounts', { holder: '', program: 'Smiles' })).status).toBe(400);

    const lista = async () => (await send(jar, 'GET', '/api/admin/finance/wallet')).json;
    const minha = async () => (await lista()).accounts.find((a: any) => a.id === id);
    expect(await minha()).toMatchObject({ balance: 100000, costCents: 245000, avgPerThousandCents: 2450, cpfLimit: 24 });

    // Entrada do clube e saída maior que o saldo.
    expect((await send(jar, 'POST', `/api/admin/finance/wallet/accounts/${id}/movements`, { kind: 'club_credit', miles: 10000, costCents: 35680, occurredOn: today })).status).toBe(201);
    expect(await minha()).toMatchObject({ balance: 110000, costCents: 280680 });
    expect((await send(jar, 'POST', `/api/admin/finance/wallet/accounts/${id}/movements`, { kind: 'sale', miles: 999999, occurredOn: today })).status).toBe(409);

    // Venda em reais: as milhas saem pelo custo médio (280.680 x 50.000 / 110.000) e o custo da emissão acompanha.
    const venda = await send(jar, 'POST', '/api/admin/finance/sales/direct', { customerName: 'Cliente Milhas', origin: 'BSB', destination: 'LIS', saleDate: today, currency: 'BRL', grossAmountCents: 500000 });
    expect(venda.status).toBe(201);
    const emissao = await send(jar, 'POST', `/api/admin/finance/sales/${venda.json.id}/issuances`, { mode: 'miles', currency: 'BRL' });
    expect(emissao.status).toBe(201);
    const issuanceUrl = `/api/admin/finance/issuances/${emissao.json.id}`;
    const uso = await send(jar, 'POST', `${issuanceUrl}/wallet-usage`, { accountId: id, miles: 50000 });
    expect(uso.status).toBe(201);
    expect(uso.json).toMatchObject({ costCents: 127582, issuanceCostCents: 127582 });
    const emissaoDepois = async () => (await send(jar, 'GET', `/api/admin/finance/sales/${venda.json.id}`)).json.issuances[0];
    expect(await emissaoDepois()).toMatchObject({ milesQuantity: 50000, milesCostCents: 127582, loyaltyProgram: 'LATAM Pass' });
    expect(await minha()).toMatchObject({ balance: 60000, costCents: 280680 - 127582 });
    expect((await send(jar, 'POST', `${issuanceUrl}/wallet-usage`, { accountId: id, miles: 60001 })).status).toBe(409);
    // Não volta para dinheiro com milhas da carteira lançadas.
    expect((await send(jar, 'PATCH', issuanceUrl, { mode: 'cash' })).json.error).toBe('issuance_has_mileage_allocations');

    // Estorno devolve o saldo e zera o custo da emissão.
    expect((await send(jar, 'POST', `/api/admin/finance/wallet/movements/${(await send(jar, 'GET', `${issuanceUrl}/wallet-usage`)).json.usages[0].id}/void`, { reason: 'conta errada' })).status).toBe(200);
    expect(await minha()).toMatchObject({ balance: 110000 });
    expect(await emissaoDepois()).toMatchObject({ milesQuantity: 0, milesCostCents: 0 });

    // Venda em euros: pede o câmbio e converte o custo (R$ -> €).
    const vendaEur = await send(jar, 'POST', '/api/admin/finance/sales/direct', { customerName: 'Cliente Europa', origin: 'LIS', destination: 'GRU', saleDate: today, currency: 'EUR', grossAmountCents: 90000 });
    const emissaoEur = await send(jar, 'POST', `/api/admin/finance/sales/${vendaEur.json.id}/issuances`, { mode: 'miles', currency: 'EUR' });
    const urlEur = `/api/admin/finance/issuances/${emissaoEur.json.id}/wallet-usage`;
    const semCambio = await send(jar, 'POST', urlEur, { accountId: id, miles: 40000 });
    expect(semCambio.status).toBe(422);
    expect(semCambio.json).toMatchObject({ error: 'fx_rate_required', currency: 'EUR', costBrlCents: 102065 });
    const comCambio = await send(jar, 'POST', urlEur, { accountId: id, miles: 40000, fxRate: 6 });
    expect(comCambio.status).toBe(201);
    expect(comCambio.json.issuanceCostCents).toBe(Math.round(102065 / 6));

    // Saldo informado pelo programa diferente do daqui: alerta e conferência criam um ajuste.
    expect((await internal([{ sourceId: 'gmail-1', kind: 'balance', program: 'LATAM Pass', holderHint: 'Carlos', memberNumber: '0633000545', balance: 80000, occurredAt: now, subject: 'Saldo' }])).status).toBe(200);
    const comDivergencia = await lista();
    expect(comDivergencia.accounts.find((a: any) => a.id === id)).toMatchObject({ reportedBalance: 80000, divergence: 80000 - 70000 });
    expect(comDivergencia.alerts.some((a: any) => a.kind === 'divergence' && a.accountId === id)).toBe(true);
    const conferido = await send(jar, 'POST', `/api/admin/finance/wallet/accounts/${id}/reconcile`, {});
    expect(conferido.json).toMatchObject({ ok: true, adjusted: 10000 });
    expect(await minha()).toMatchObject({ balance: 80000, divergence: 0 });
  }, 120_000);

  it('promoções por conta e mês: registra, aparece na visão geral, valida e estorna sem mexer no saldo', async () => {
    const jar = await masterJar();
    const conta = await send(jar, 'POST', '/api/admin/finance/wallet/accounts', { holder: 'Mateus', program: 'LATAM Pass', openingMiles: 10000, openingCostCents: 34930 });
    expect(conta.status).toBe(201);
    const id = conta.json.id as string;
    const minha = async () => (await send(jar, 'GET', '/api/admin/finance/wallet')).json.accounts.find((a: any) => a.id === id);
    expect((await minha()).promos).toEqual([]);
    const semPromo = async () => (await send(jar, 'GET', '/api/admin/finance/wallet')).json.alerts.some((a: any) => a.kind === 'promo_missing' && a.accountId === id);
    expect(await semPromo()).toBe(true);

    const promoUrl = `/api/admin/finance/wallet/accounts/${id}/promos`;
    expect((await send(jar, 'POST', promoUrl, { name: '', doneOn: today })).status).toBe(400);
    expect((await send(jar, 'POST', promoUrl, { name: 'Livelo para LATAM Turbo', doneOn: '30/10/2026' })).status).toBe(400);
    expect((await send(jar, 'POST', promoUrl, { name: 'Livelo para LATAM Turbo', doneOn: today, bonusPercent: 'muito' })).status).toBe(400);
    expect((await send(jar, 'POST', '/api/admin/finance/wallet/accounts/00000000-0000-4000-8000-000000000000/promos', { name: 'X', doneOn: today })).status).toBe(404);

    const feita = await send(jar, 'POST', promoUrl, { name: 'Livelo para LATAM Turbo', doneOn: today, pointsSent: 10000, bonusPercent: 90, milesReceived: 19000, note: 'teste' });
    expect(feita.status).toBe(201);
    const promos = (await minha()).promos;
    expect(promos).toHaveLength(1);
    expect(promos[0]).toMatchObject({ name: 'Livelo para LATAM Turbo', month: today.slice(0, 7), doneOn: today, pointsSent: 10000, bonusPercent: 90, milesReceived: 19000 });
    // Só controle: o saldo da conta não muda, e o aviso de "sem promoção neste mês" some.
    expect(await minha()).toMatchObject({ balance: 10000 });
    expect(await semPromo()).toBe(false);

    const voidUrl = `/api/admin/finance/wallet/promos/${feita.json.id}/void`;
    expect((await send(jar, 'POST', voidUrl, { reason: '' })).status).toBe(400);
    expect((await send(jar, 'POST', voidUrl, { reason: 'conta errada' })).status).toBe(200);
    expect((await send(jar, 'POST', voidUrl, { reason: 'conta errada' })).status).toBe(409);
    expect((await minha()).promos).toEqual([]);
    expect(await semPromo()).toBe(true);
  });

  it('clubes: e-mails dos programas atualizam crédito e situação, sem repetir e sem dono errado', async () => {
    const jar = await masterJar();
    const conta = await send(jar, 'POST', '/api/admin/finance/wallet/accounts', { holder: 'Mateus', program: 'Smiles', memberNumber: '186196592', openingMiles: 33500, openingCostCents: 50000, openingDate: '2026-01-01' });
    const outra = await send(jar, 'POST', '/api/admin/finance/wallet/accounts', { holder: 'Mateus', program: 'Livelo', openingMiles: 1000, openingCostCents: 4490 });
    expect(conta.status).toBe(201);
    const clube = await send(jar, 'POST', '/api/admin/finance/wallet/clubs', { accountId: conta.json.id, name: 'Clube Smiles 1.000', monthlyMiles: 1000, monthlyCostCents: 4600, creditDay: 28, cardLabel: 'Nubank' });
    expect(clube.status).toBe(201);
    const lista = async () => (await send(jar, 'GET', '/api/admin/finance/wallet')).json;
    const doClube = async () => (await lista()).accounts.find((a: any) => a.id === conta.json.id).clubs[0];

    // Sem token a rota interna não responde.
    expect((await internal([], null)).status).toBe(401);
    expect((await internal([], 'token-errado-com-mais-de-trinta-e-dois-caracteres')).status).toBe(401);

    const falha = { sourceId: 'gmail-smiles-falha', kind: 'club_payment_failed', program: 'Smiles', holderHint: 'Mateus', memberNumber: '186196592', balance: 33500, monthlyCostCents: 4600, occurredAt: now, subject: 'pagamento não concluído' };
    const r1 = await (await internal([falha])).json() as Record<string, number>;
    expect(r1).toMatchObject({ received: 1, created: 1, applied: 1, unmatched: 0 });
    expect(await doClube()).toMatchObject({ status: 'payment_failed', lastEvent: 'Pagamento recusado' });
    expect((await lista()).alerts.some((a: any) => a.kind === 'club_payment_failed' && a.clubId === clube.json.id)).toBe(true);
    // O mesmo e-mail lido de novo não duplica nada.
    expect(await (await internal([falha])).json()).toMatchObject({ created: 0, applied: 0 });

    // Mensalidade aprovada e crédito do mês: clube volta a ativo e entra o movimento com a mensalidade como custo.
    const credito = { sourceId: 'gmail-smiles-credito', kind: 'club_credited', program: 'Smiles', holderHint: 'Mateus', memberNumber: '186196592', miles: 1000, balance: 34500, monthlyCostCents: 4600, occurredAt: new Date(Date.now() + 60_000).toISOString(), subject: 'pontos chegaram' };
    expect(await (await internal([credito])).json()).toMatchObject({ created: 1, applied: 1 });
    expect(await doClube()).toMatchObject({ status: 'active', lastCreditOn: today });
    const conta2 = (await lista()).accounts.find((a: any) => a.id === conta.json.id);
    expect(conta2).toMatchObject({ balance: 34500, costCents: 54600, reportedBalance: 34500, divergence: 0 });

    // Crédito de antes do saldo inicial já está dentro dele: o e-mail é registrado mas não soma de novo.
    const antigo = { sourceId: 'gmail-smiles-antigo', kind: 'club_credited', program: 'Smiles', holderHint: 'Mateus', miles: 1000, monthlyCostCents: 4600, occurredAt: '2025-12-15T10:00:00Z', subject: 'pontos de dezembro' };
    expect(await (await internal([antigo])).json()).toMatchObject({ created: 1, applied: 1 });
    expect((await lista()).accounts.find((a: any) => a.id === conta.json.id)).toMatchObject({ balance: 34500, costCents: 54600 });
    // Saldo citado com data anterior à do e-mail não atropela um saldo mais novo.
    const saldoVelho = { sourceId: 'gmail-smiles-saldo-velho', kind: 'balance', program: 'Smiles', holderHint: 'Mateus', balance: 1, balanceAt: '2026-01-02T12:00:00Z', occurredAt: new Date(Date.now() + 120_000).toISOString(), subject: 'saldo antigo' };
    await internal([saldoVelho]);
    expect((await lista()).accounts.find((a: any) => a.id === conta.json.id)).toMatchObject({ reportedBalance: 34500 });

    // Programa sem conta cadastrada e nome desconhecido: fica guardado para ligar depois.
    const sozinho = { sourceId: 'gmail-esfera-ok', kind: 'club_payment_ok', program: 'Esfera', holderHint: 'Juliana', occurredAt: now, subject: 'mensalidade aprovada' };
    expect(await (await internal([sozinho])).json()).toMatchObject({ created: 1, applied: 0, unmatched: 1 });
    expect((await lista()).unmatchedEvents).toHaveLength(1);
    // Programa certo mas pessoa que não existe: também não adivinha.
    const desconhecido = { sourceId: 'gmail-livelo-x', kind: 'balance', program: 'Livelo', holderHint: 'Zélia', balance: 10, occurredAt: now, subject: 'saldo' };
    expect(await (await internal([desconhecido])).json()).toMatchObject({ unmatched: 1 });
    expect(outra.status).toBe(201);
    // Dado inválido é descartado sem derrubar o lote.
    expect(await (await internal([{ sourceId: '', kind: 'x' }, null])).json()).toMatchObject({ received: 2, invalid: 2, created: 0 });
  }, 120_000);
});
