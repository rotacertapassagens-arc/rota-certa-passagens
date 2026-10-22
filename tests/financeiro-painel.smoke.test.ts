/**
 * Financeiro, painel novo: venda direta (com e sem recebimento), valor equivalente em R$ sem somar moedas,
 * lista de voos com lucro, contas a receber, recibo por venda e PDF anexado. Worker real + D1 local isolado.
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
  TOKEN_PEPPER: 'painel-smoke-token-pepper-at-least-32-chars',
  RATE_LIMIT_SECRET: 'painel-smoke-rate-limit-secret-32-characters',
  RESEND_API_KEY: 'unused-in-capture-mode',
  MASTER_BOOTSTRAP_TOKEN: 'painel-smoke-bootstrap-token-long-enough-00',
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
  read() { return { cookie: this.cookieHeader() }; }
}

describe('Financeiro: painel novo, venda direta, lucro por voo e recibos (Worker + D1 local)', () => {
  let persistTo: string;
  let worker: Unstable_DevWorker;

  beforeAll(async () => {
    persistTo = mkdtempSync(join(tmpdir(), 'rota-certa-painel-smoke-'));
    runWrangler(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persistTo, '--config', 'wrangler.jsonc']);
    worker = await unstable_dev('worker/index.ts', { config: 'wrangler.jsonc', local: true, persistTo, vars: VARS, logLevel: 'error', experimental: { disableExperimentalWarning: true } });
  }, 60_000);

  afterAll(async () => {
    if (worker) await worker.stop();
    if (persistTo) rmSync(persistTo, { recursive: true, force: true });
  });

  async function masterJar() {
    const email = 'ana@example.com';
    const senha = 'SenhaPainel12345';
    const invite = await worker.fetch('/api/admin/bootstrap/master-invites', { method: 'POST', headers: { authorization: `Bearer ${VARS.MASTER_BOOTSTRAP_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ email, name: 'Ana Souza' }) });
    expect(invite.status).toBe(201);
    await knownInviteCode(persistTo, email, '717171');
    expect((await worker.fetch('/api/admin/master-invites/accept', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code: '717171', password: senha }) })).status).toBe(200);
    const res = await worker.fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: senha }) });
    expect(res.status).toBe(200);
    const jar = new CookieJar();
    jar.absorb(res);
    return jar;
  }

  const send = async (jar: CookieJar, method: string, path: string, data?: unknown) => {
    const res = await worker.fetch(path, { method, headers: jar.json(), ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const text = await res.text();
    let json: Record<string, any> = {};
    try { json = JSON.parse(text); } catch { /* binário */ }
    return { status: res.status, json, res };
  };
  const today = new Date().toISOString().slice(0, 10);

  it('cobre venda direta, lucro por voo, contas a receber e recibo de ponta a ponta', async () => {
    const jar = await masterJar();

    // Sem sessão master nada abre.
    expect((await worker.fetch('/api/admin/finance/flights')).status).toBe(403);
    expect((await worker.fetch('/api/admin/finance/receivables')).status).toBe(403);

    const account = await send(jar, 'POST', '/api/admin/finance/accounts', { name: 'Conta Rota Certa', type: 'bank', currency: 'EUR' });
    expect(account.status).toBe(201);
    const accountId = account.json.id as string;

    // --- venda direta já recebida: € em cima, R$ só informativo -----------------------------------
    const bad = await send(jar, 'POST', '/api/admin/finance/sales/direct', { customerName: 'X', currency: 'EUR', saleDate: today, grossAmountCents: 100 });
    expect(bad.status).toBe(400);
    const sameAlt = await send(jar, 'POST', '/api/admin/finance/sales/direct', { customerName: 'Cliente Teste', currency: 'EUR', saleDate: today, grossAmountCents: 100, altCurrency: 'EUR', altAmountCents: 100 });
    expect(sameAlt.status).toBe(400);
    const noAccount = await send(jar, 'POST', '/api/admin/finance/sales/direct', { customerName: 'Cliente Teste', currency: 'EUR', saleDate: today, grossAmountCents: 100, payment: { received: true, method: 'pix', accountId: crypto.randomUUID() } });
    expect(noAccount.status).toBe(422);

    const first = await send(jar, 'POST', '/api/admin/finance/sales/direct', {
      customerName: 'Giovane Teste', origin: 'VCP', destination: 'LIS', saleDate: today, currency: 'EUR', grossAmountCents: 120000,
      altCurrency: 'BRL', altAmountCents: 672600, payment: { received: true, method: 'pix', accountId },
    });
    expect(first.status).toBe(201);
    expect(first.json.protocol).toMatch(/^VD-\d{4}-00001$/);
    const second = await send(jar, 'POST', '/api/admin/finance/sales/direct', {
      customerName: 'Maria Teste', origin: 'MRS', destination: 'MCZ', saleDate: today, currency: 'EUR', grossAmountCents: 156817, discountCents: 0,
    });
    expect(second.status).toBe(201);
    expect(second.json.protocol).toMatch(/^VD-\d{4}-00002$/);

    // A venda direta não aparece na Central de Propostas (kind próprio) nem cria comissão.
    const leads = await worker.fetch('/api/admin/leads', { headers: jar.read() });
    expect(JSON.stringify(await leads.json())).not.toContain('Giovane Teste');

    // Recebido entra no caixa em euros; o R$ fica só como informação da venda.
    const overview = await send(jar, 'GET', `/api/admin/finance/dashboard/overview?from=${today}&to=${today}&regime=cash`);
    const eur = (overview.json.indicators as Array<Record<string, any>>).find((i) => i.currency === 'EUR');
    expect(eur?.recebidoCents).toBe(120000);
    expect((overview.json.indicators as Array<Record<string, any>>).some((i) => i.currency === 'BRL')).toBe(false);

    // --- contas a receber: a primeira já está paga, a segunda ainda sem parcela --------------------------
    expect((await send(jar, 'GET', '/api/admin/finance/receivables')).json.receivables).toHaveLength(0);
    const secondId = second.json.id as string;
    expect((await send(jar, 'POST', `/api/admin/finance/sales/${secondId}/receivables`, { installments: [{ dueDate: today, expectedAmountCents: 156817, method: 'transfer' }] })).status).toBe(201);
    const open = (await send(jar, 'GET', '/api/admin/finance/receivables')).json.receivables as Array<Record<string, any>>;
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ customerName: 'Maria Teste', status: 'open', currency: 'EUR', expectedAmountCents: 156817 });
    expect((await send(jar, 'GET', '/api/admin/finance/receivables?status=all')).json.receivables).toHaveLength(2);

    // --- voos: custo pendente entra no lucro projetado -----------------------------------------------
    expect((await send(jar, 'POST', `/api/admin/finance/sales/${secondId}/issuances`, { mode: 'cash', currency: 'EUR', cashAmountCents: 100000, airportFeesCents: 5000 })).status).toBe(201);
    const flights = (await send(jar, 'GET', '/api/admin/finance/flights')).json.flights as Array<Record<string, any>>;
    expect(flights).toHaveLength(2);
    const maria = flights.find((f) => f.customerName === 'Maria Teste')!;
    expect(maria).toMatchObject({ direct: true, hasReceipt: false, origin: 'MRS', destination: 'MCZ' });
    expect(maria.profit.projectedGrossProfitCents).toBe(156817 - 105000);
    expect(maria.profit.realizedGrossProfitCents).toBe(156817);
    const giovane = flights.find((f) => f.customerName === 'Giovane Teste')!;
    expect(giovane).toMatchObject({ altCurrency: 'BRL', altAmountCents: 672600 });

    // --- equivalente em R$ editável, sem moeda igual -------------------------------------------------
    expect((await send(jar, 'PATCH', `/api/admin/finance/sales/${secondId}`, { altCurrency: 'EUR', altAmountCents: 10 })).status).toBe(400);
    expect((await send(jar, 'PATCH', `/api/admin/finance/sales/${secondId}`, { altCurrency: 'BRL', altAmountCents: 970000 })).status).toBe(200);
    expect((await send(jar, 'PATCH', `/api/admin/finance/sales/${secondId}`, { altCurrency: null })).status).toBe(200);

    // --- recibo --------------------------------------------------------------------------------------
    const empty = await send(jar, 'GET', `/api/admin/finance/sales/${secondId}/receipt`);
    expect(empty.status).toBe(200);
    expect(empty.json.receipt).toBeNull();
    expect(empty.json.sale).toMatchObject({ customerName: 'Maria Teste', netAmountCents: 156817, currency: 'EUR' });

    const receiptBody = {
      number: 'RC-2026-Y859BI', issuedOn: today, customerName: 'Maria Teste', passengerKind: 'Adulto', baggage: 'Sem bagagem despachada',
      reservationCodes: 'Y859BI', ticketNumber: '057 236 563 577 9', issuedBy: 'Air France', currency: 'EUR',
      segments: [{ date: today, flight: 'AF7345', airline: 'Air France', from: 'mrs', fromCity: 'Marselha', depart: '20:30', to: 'CDG', toCity: 'Paris', arrive: '22:00', cls: 'Y' }],
      lines: [{ title: 'Passagem aérea Marselha (MRS) > Maceió (MCZ)', subtitle: '1 passageiro adulto', amountCents: 138290 }, { title: 'Taxas de serviço e emissão', subtitle: 'Rota Certa Passagens', amountCents: 18527 }],
      paymentMethod: 'transfer', status: 'paid',
    };
    expect((await send(jar, 'PUT', `/api/admin/finance/sales/${secondId}/receipt`, { ...receiptBody, number: '!!' })).status).toBe(400);
    expect((await send(jar, 'PUT', `/api/admin/finance/sales/${secondId}/receipt`, { ...receiptBody, currency: 'BRL' })).status).toBe(422);
    const saved = await send(jar, 'PUT', `/api/admin/finance/sales/${secondId}/receipt`, receiptBody);
    expect(saved.status).toBe(201);
    const again = await send(jar, 'PUT', `/api/admin/finance/sales/${secondId}/receipt`, { ...receiptBody, baggage: '1 peça despachada' });
    expect(again.status).toBe(200);
    expect(again.json.id).toBe(saved.json.id);
    // O mesmo número não vale para outra venda.
    expect((await send(jar, 'PUT', `/api/admin/finance/sales/${first.json.id}/receipt`, { ...receiptBody, customerName: 'Giovane Teste' })).status).toBe(409);

    const loaded = await send(jar, 'GET', `/api/admin/finance/sales/${secondId}/receipt`);
    expect(loaded.json.receipt.number).toBe('RC-2026-Y859BI');
    expect(loaded.json.receipt.data).toMatchObject({ baggage: '1 peça despachada', totalCents: 156817 });
    expect(loaded.json.receipt.data.segments[0].from).toBe('MRS');
    expect((await send(jar, 'GET', '/api/admin/finance/flights')).json.flights.find((f: Record<string, any>) => f.customerName === 'Maria Teste').hasReceipt).toBe(true);

    // --- PDF anexado ao recibo -------------------------------------------------------------------------
    const receiptId = saved.json.id as string;
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n').toString('base64');
    expect((await send(jar, 'POST', `/api/admin/finance/receipts/${receiptId}/files`, { filename: 'Recibo.pdf', mime: 'text/html', base64: pdf })).status).toBe(400);
    expect((await send(jar, 'POST', `/api/admin/finance/receipts/${receiptId}/files`, { filename: 'falso.pdf', mime: 'application/pdf', base64: Buffer.from('nao e um pdf de verdade').toString('base64') })).status).toBe(415);
    const upload = await send(jar, 'POST', `/api/admin/finance/receipts/${receiptId}/files`, { filename: 'Recibo Maria.pdf', mime: 'application/pdf', base64: pdf });
    expect(upload.status).toBe(201);
    const withFile = await send(jar, 'GET', `/api/admin/finance/sales/${secondId}/receipt`);
    expect(withFile.json.files).toHaveLength(1);
    expect(withFile.json.files[0]).toMatchObject({ filename: 'Recibo Maria.pdf', mime: 'application/pdf' });
    const download = await worker.fetch(`/api/admin/finance/receipt-files/${upload.json.id}`, { headers: jar.read() });
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await download.arrayBuffer()).toString().startsWith('%PDF')).toBe(true);
    expect((await worker.fetch(`/api/admin/finance/receipt-files/${upload.json.id}`)).status).toBe(403);
    expect((await send(jar, 'DELETE', `/api/admin/finance/receipt-files/${upload.json.id}`)).status).toBe(200);
    expect((await send(jar, 'GET', `/api/admin/finance/sales/${secondId}/receipt`)).json.files).toHaveLength(0);

    // --- cofrinho em reais (Mercado Pago): saldo na moeda da conta, para conferir com o app ---------------------
    expect((await worker.fetch('/api/admin/finance/accounts/balances')).status).toBe(403);
    const cofre = await send(jar, 'POST', '/api/admin/finance/accounts', { name: 'Cofrinho Mercado Pago', type: 'digital_wallet', currency: 'BRL', openingBalanceCents: 100000, openingBalanceAt: today });
    expect(cofre.status).toBe(201);
    const cofreId = cofre.json.id as string;
    const balanceOf = async (id: string) => ((await send(jar, 'GET', '/api/admin/finance/accounts/balances')).json.accounts as Array<Record<string, any>>).find((account) => account.id === id)!;
    expect(await balanceOf(cofreId)).toMatchObject({ currency: 'BRL', balanceCents: 100000, inCents: 0, outCents: 0 });

    // Venda em € paga em R$ para uma conta em R$: sem o valor creditado em R$ não grava.
    const venda = { customerName: 'Amigo Teste', origin: 'LIS', destination: 'SSA', saleDate: today, currency: 'EUR', grossAmountCents: 120000 };
    const semValor = await send(jar, 'POST', '/api/admin/finance/sales/direct', { ...venda, payment: { received: true, method: 'pix', accountId: cofreId } });
    expect(semValor.status).toBe(422);
    expect(semValor.json.error).toBe('account_amount_required');
    const pix = await send(jar, 'POST', '/api/admin/finance/sales/direct', { ...venda, altCurrency: 'BRL', altAmountCents: 720000, payment: { received: true, method: 'pix', accountId: cofreId, accountAmountCents: 720000 } });
    expect(pix.status).toBe(201);
    expect(await balanceOf(cofreId)).toMatchObject({ balanceCents: 820000, inCents: 720000 });
    // A conta em euros não é afetada pelo valor em reais.
    expect(await balanceOf(accountId)).toMatchObject({ currency: 'EUR', balanceCents: 120000 });

    // Conta a pagar em € paga pelo cofrinho: debita em R$.
    const categoria = await send(jar, 'POST', '/api/admin/finance/categories', { kind: 'operating_expense', name: 'Despesas gerais' });
    expect(categoria.status).toBe(201);
    const obrigacao = await send(jar, 'POST', '/api/admin/finance/obligations', { kind: 'operating_expense', categoryId: categoria.json.id, competencyDate: today, dueDate: today, amountCents: 5000, currency: 'EUR' });
    expect(obrigacao.status).toBe(201);
    const pagarUrl = `/api/admin/finance/obligations/${obrigacao.json.id}/payments`;
    expect((await send(jar, 'POST', pagarUrl, { paidAmountCents: 5000, currency: 'EUR', accountId: cofreId })).status).toBe(422);
    const pago = await send(jar, 'POST', pagarUrl, { paidAmountCents: 5000, currency: 'EUR', accountId: cofreId, accountAmountCents: 31000 });
    expect(pago.status).toBe(201);
    expect(await balanceOf(cofreId)).toMatchObject({ balanceCents: 789000, outCents: 31000 });
    // O estorno devolve exatamente o que saiu em R$.
    expect((await send(jar, 'POST', `/api/admin/finance/obligation-payments/${pago.json.id}/reverse`, { reason: 'teste de estorno' })).status).toBe(201);
    expect(await balanceOf(cofreId)).toMatchObject({ balanceCents: 820000, outCents: 0 });
  }, 120_000);
});
