/**
 * WHA-04: formulário de proposta → protocolo RC-AAAA-NNNNN → botão do WhatsApp, e a rota interna
 * GET /api/internal/proposals/{protocol}?phone=... usada pelo n8n. Worker real + D1 local isolado
 * (pasta temporária própria, nunca o D1 remoto), e-mail em modo capture, navegador Chromium real.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unstable_dev, type Unstable_DevWorker } from 'wrangler';
import { QUOTE_CONSENT_VERSION } from '../shared/proposalHandoff.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const WRANGLER_BIN = join(REPO_ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const API_TOKEN = 'wha04-smoke-internal-token-0123456789abcdef';
const VARS = {
  TOKEN_PEPPER: 'wha04-smoke-token-pepper-at-least-32-chars',
  RATE_LIMIT_SECRET: 'wha04-smoke-rate-limit-secret-32-characters',
  RESEND_API_KEY: 'unused-in-capture-mode',
  MASTER_BOOTSTRAP_TOKEN: 'wha04-smoke-bootstrap-token-long-enough-00',
  EMAIL_MODE: 'capture',
  ROTA_CERTA_SITE_API_TOKEN: API_TOKEN,
};
const YEAR = new Date().getUTCFullYear();
const EXPECTED_MESSAGE = (protocol: string) => `Olá! Acabei de enviar uma solicitação de orçamento pelo site da Rota Certa. Meu protocolo é ${protocol}. Quero continuar o atendimento pelo WhatsApp.`;

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
function publicFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? publicFiles(path) : [path];
  });
}

const baseLead = {
  type: 'quote', name: 'Maria Souza', email: 'maria@example.com', phone: '+351 912 345 678',
  origem: 'Lisboa', destino: 'São Paulo', ida: '2027-03-10', volta: '2027-03-25', adults: 2, children: 0, infants: 0,
  tipo: 'Ida e volta', cabinClass: 'Econômica', baggage: 'Bagagem de mão', flexibility: 'Até 3 dias',
  stopsPreference: 'Aceito escalas', paymentPreference: 'Pix', observacoes: 'Prefiro voo à noite',
  contactConsent: true, consentVersion: QUOTE_CONSENT_VERSION,
};

describe('WHA-04: proposta do site → WhatsApp → consulta interna (Worker + D1 local)', () => {
  let persistTo: string;
  let worker: Unstable_DevWorker;
  let browser: Browser | undefined;

  beforeAll(async () => {
    persistTo = mkdtempSync(join(tmpdir(), 'rota-certa-wha04-smoke-'));
    runWrangler(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persistTo, '--config', 'wrangler.jsonc']);
    worker = await unstable_dev('worker/index.ts', { config: 'wrangler.jsonc', local: true, persistTo, vars: VARS, logLevel: 'error', experimental: { disableExperimentalWarning: true } });
    browser = await chromium.launch();
  }, 90_000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (worker) await worker.stop();
    if (persistTo) rmSync(persistTo, { recursive: true, force: true });
  });

  const sendLead = (payload: Record<string, unknown>) => worker.fetch('/api/lead', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const internal = (path: string, headers: Record<string, string> = { authorization: `Bearer ${API_TOKEN}` }) => worker.fetch(path, { headers });
  const count = (sql: string) => Number(d1Query<{ n: number }>(persistTo, sql)[0]!.n);

  it('grava o pedido, gera um protocolo único e é idempotente no reenvio', async () => {
    const submissionId = crypto.randomUUID();
    const first = await sendLead({ ...baseLead, submissionId, source: { utm_source: 'instagram', utm_medium: 'bio', utm_campaign: 'outubro', utm_content: 'reel-1', utm_term: 'lisboa', page: '/', referrer: 'l.instagram.com', capturedAt: new Date().toISOString() } });
    const created = await first.json() as Record<string, unknown>;
    expect(first.status, JSON.stringify(created)).toBe(201);
    expect(created).toMatchObject({ ok: true, protocol: `RC-${YEAR}-00001`, status: 'received_awaiting_whatsapp' });
    expect(new URL(String(created.whatsappUrl)).searchParams.get('text')).toBe(EXPECTED_MESSAGE(`RC-${YEAR}-00001`));
    expect(JSON.stringify(created)).not.toContain(API_TOKEN);

    // Reenvio igual (clique duplo, rede caiu): mesmo protocolo, nenhum pedido ou e-mail novo.
    const again = await sendLead({ ...baseLead, submissionId });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ protocol: `RC-${YEAR}-00001`, replayed: true });
    // Mesmo identificador com dados diferentes não reaproveita o pedido.
    expect((await sendLead({ ...baseLead, submissionId, destino: 'Recife' })).status).toBe(409);

    expect(count("SELECT count(*) n FROM lead_requests WHERE kind='flight_quote'")).toBe(1);
    expect(count("SELECT count(*) n FROM email_events WHERE template='flight_quote_customer'")).toBe(1);
    const [stored] = d1Query<Record<string, unknown>>(persistTo, `SELECT customer_phone,customer_phone_digits,contact_consent,consent_version,whatsapp_consent_at,stops_preference,
      utm_source,utm_medium,utm_campaign,utm_content,utm_term,source_page,source_referrer,source_captured_at,status FROM lead_requests WHERE protocol='RC-${YEAR}-00001'`);
    expect(stored).toMatchObject({
      customer_phone: '+351912345678', customer_phone_digits: '351912345678', contact_consent: 1, consent_version: QUOTE_CONSENT_VERSION,
      stops_preference: 'Aceito escalas', utm_source: 'instagram', utm_medium: 'bio', utm_campaign: 'outubro', utm_content: 'reel-1', utm_term: 'lisboa',
      source_page: '/', source_referrer: 'l.instagram.com', status: 'new',
    });
    expect(stored!.whatsapp_consent_at).toBeTruthy();
    expect(stored!.source_captured_at).toBeTruthy();
  }, 60_000);

  it('telefone é obrigatório e precisa do código do país', async () => {
    expect((await sendLead({ ...baseLead, email: 'sem-ddi@example.com', phone: '912 345 678' })).status).toBe(400);
    expect(await (await sendLead({ ...baseLead, email: 'sem-ddi@example.com', phone: '(11) 91234-5678' })).json()).toEqual({ error: 'invalid_phone' });
    expect((await sendLead({ ...baseLead, email: 'sem-ddi@example.com', phone: '' })).status).toBe(400);
    expect((await sendLead({ ...baseLead, email: 'sem-ddi@example.com', contactConsent: false })).status).toBe(400);
  }, 30_000);

  it('rota interna: exige o token e confere protocolo + telefone inteiro', async () => {
    const protocol = `RC-${YEAR}-00001`;
    const path = `/api/internal/proposals/${protocol}?phone=351912345678`;

    // Sem credencial válida: 401, mesmo conhecendo protocolo e telefone.
    expect((await internal(path, {})).status).toBe(401);
    expect((await internal(path, { authorization: 'Bearer token-errado-token-errado-token-errado' })).status).toBe(401);
    expect((await internal(path, { authorization: `Basic ${btoa(`n8n:${API_TOKEN}`)}` })).status).toBe(401);
    expect((await internal(path, { authorization: API_TOKEN })).status).toBe(401);
    expect((await internal(`${path}&token=${API_TOKEN}`, {})).status).toBe(401);
    expect((await internal('/api/internal/nao-existe', {})).status).toBe(401);

    // Telefone diferente ou parcial: 404.
    for (const phone of ['351912345679', '912345678', '12345678', '3519123456789', '']) {
      expect((await internal(`/api/internal/proposals/${protocol}?phone=${phone}`)).status, phone).toBe(404);
    }
    expect((await internal(`/api/internal/proposals/${protocol}`)).status).toBe(404);
    expect((await internal(`/api/internal/proposals/RC-${YEAR}-99999?phone=351912345678`)).status).toBe(404);

    // Protocolo + telefone certos: só o pedido correto, só os campos do contrato.
    const ok = await internal(path);
    expect(ok.status).toBe(200);
    const text = await ok.text();
    expect(JSON.parse(text)).toEqual({
      protocol, phone: '351912345678', name: 'Maria Souza', contactName: 'Maria Souza',
      collected: {
        origem: 'Lisboa', destino: 'São Paulo', tipoViagem: 'ida_e_volta', dataIda: '2027-03-10', dataVolta: '2027-03-25',
        adultos: 2, criancas: 0, bebes: 0, cabine: 'economica', bagagem: 'bagagem_de_mao', aceitaEscalas: true, vooDireto: false,
        companhiaPreferida: null, maxEscalas: null, consentimento: true,
      },
      classificacao: 'normal',
    });
    for (const leaked of [API_TOKEN, 'maria@example.com', 'Pix', 'Prefiro voo', 'instagram']) expect(text).not.toContain(leaked);
    expect(ok.headers.get('cache-control')).toBe('no-store');

    // Telefone vindo formatado do WhatsApp e protocolo em minúsculas continuam valendo (número inteiro).
    expect((await internal(`/api/internal/proposals/${protocol.toLowerCase()}?phone=%2B351%20912%20345%20678`)).status).toBe(200);

    // Duas leituras não criam nada: mesma resposta, mesmo número de pedidos.
    const before = count("SELECT count(*) n FROM lead_requests");
    expect(await (await internal(path)).text()).toBe(text);
    expect(count("SELECT count(*) n FROM lead_requests")).toBe(before);
  }, 60_000);

  it('consentimento sem o texto do WhatsApp não vira true; pedidos diferentes não se misturam', async () => {
    // Página antiga em cache: aceite sem a versão do texto que cita o WhatsApp.
    const old = await sendLead({ ...baseLead, email: 'joao@example.com', name: 'João Lima', phone: '+55 11 91234-5678', consentVersion: undefined, submissionId: crypto.randomUUID() });
    const { protocol } = await old.json() as { protocol: string };
    expect(protocol).toBe(`RC-${YEAR}-00002`);
    const body = await (await internal(`/api/internal/proposals/${protocol}?phone=5511912345678`)).json() as { collected: { consentimento: boolean }; name: string };
    expect(body.name).toBe('João Lima');
    expect(body.collected.consentimento).toBe(false);
    // O telefone de um pedido não abre o pedido de outra pessoa.
    expect((await internal(`/api/internal/proposals/${protocol}?phone=351912345678`)).status).toBe(404);
    expect((await internal(`/api/internal/proposals/RC-${YEAR}-00001?phone=5511912345678`)).status).toBe(404);
  }, 60_000);

  it('página: mostra protocolo, estado e botão do WhatsApp, sem redirecionar; recarregar não cria outro pedido', async () => {
    const context = await browser!.newContext();
    const page = await context.newPage();
    const scripts: string[] = [];
    page.on('response', async (response) => {
      if (/\.(js|html)(\?|$)|\/proposta-voo/.test(response.url())) scripts.push(await response.text().catch(() => ''));
    });
    await page.goto(`http://127.0.0.1:${worker.port}/proposta-voo.html?utm_source=google&utm_medium=cpc&utm_campaign=lisboa&destino=Lisboa`);
    await page.fill('#quoteName', 'Ana Navegador');
    await page.fill('#quoteEmail', 'ana.navegador@example.com');
    await page.fill('#quotePhone', '+55 21 99876-5432');
    await page.fill('#origem', 'Rio de Janeiro');
    await page.fill('#ida', '2027-05-02');
    await page.fill('#volta', '2027-05-20');
    await page.selectOption('#stopsPreference', 'Somente voo direto');
    await page.check('#contactConsent');
    const urlBefore = page.url();
    await page.click('#quoteForm button[type=submit]');
    await page.waitForSelector('#quoteSuccess:not(.hidden)');

    const protocol = (await page.textContent('#successProtocol'))!.trim();
    expect(protocol).toBe(`RC-${YEAR}-00003`);
    expect((await page.textContent('#successStatus'))!.replace(/\s+/g, ' ').trim()).toBe('Recebida — aguardando início no WhatsApp');
    const button = page.locator('#successWhatsapp');
    expect((await button.textContent())!.trim()).toBe('Continuar atendimento pelo WhatsApp');
    const href = new URL((await button.getAttribute('href'))!);
    expect(href.origin + href.pathname).toBe('https://wa.me/351925307391');
    expect(href.searchParams.get('text')).toBe(EXPECTED_MESSAGE(protocol));
    expect(await page.isHidden('#quoteForm')).toBe(true);

    // Sem redirecionamento automático: a página continua a mesma e nenhuma aba nova abriu.
    await page.waitForTimeout(1500);
    expect(page.url()).toBe(urlBefore);
    expect(context.pages()).toHaveLength(1);

    // Recarregar a tela de sucesso mostra o mesmo protocolo e não grava outro pedido.
    const leadsBefore = count("SELECT count(*) n FROM lead_requests");
    await page.reload();
    await page.waitForSelector('#quoteSuccess:not(.hidden)');
    expect((await page.textContent('#successProtocol'))!.trim()).toBe(protocol);
    expect(count("SELECT count(*) n FROM lead_requests")).toBe(leadsBefore);

    const [stored] = d1Query<Record<string, unknown>>(persistTo, `SELECT customer_phone_digits,destination,utm_source,utm_medium,utm_campaign,source_page,stops_preference,consent_version FROM lead_requests WHERE protocol='${protocol}'`);
    expect(stored).toMatchObject({ customer_phone_digits: '5521998765432', destination: 'Lisboa', utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'lisboa', stops_preference: 'Somente voo direto', consent_version: QUOTE_CONSENT_VERSION });
    expect(String(stored!.source_page)).toMatch(/^\/proposta-voo/);

    // O token nunca chega ao navegador: nem no que a página baixou, nem em nenhum arquivo público.
    expect(scripts.length).toBeGreaterThan(0);
    for (const content of scripts) {
      expect(content).not.toContain(API_TOKEN);
      expect(content).not.toContain('ROTA_CERTA_SITE_API_TOKEN');
      expect(content).not.toContain('/api/internal');
    }
    for (const file of publicFiles(join(REPO_ROOT, 'public'))) {
      if (!/\.(js|html|json|webmanifest|css)$/.test(file)) continue;
      const content = readFileSync(file, 'utf8');
      expect(content, file).not.toContain('ROTA_CERTA_SITE_API_TOKEN');
      expect(content, file).not.toContain('/api/internal');
    }
    await context.close();
  }, 90_000);

  it('dois envios iguais ao mesmo tempo viram um pedido só, sem pular número de protocolo', async () => {
    const submissionId = crypto.randomUUID();
    const payload = { ...baseLead, email: 'duplo@example.com', name: 'Clique Duplo', submissionId };
    const responses = await Promise.all([sendLead(payload), sendLead(payload)]);
    const bodies = await Promise.all(responses.map((r) => r.json() as Promise<{ protocol: string }>));
    expect(responses.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(bodies[0]!.protocol).toBe(bodies[1]!.protocol);
    expect(count(`SELECT count(*) n FROM lead_requests WHERE submission_id='${submissionId}'`)).toBe(1);
    const next = await sendLead({ ...baseLead, email: 'seguinte@example.com', submissionId: crypto.randomUUID() });
    const nextProtocol = (await next.json() as { protocol: string }).protocol;
    expect(Number(nextProtocol.slice(-5))).toBe(Number(bodies[0]!.protocol.slice(-5)) + 1);
  }, 60_000);

  it('rate limit: credencial errada repetida bloqueia aquele IP, inclusive com o token certo', async () => {
    const path = `/api/internal/proposals/RC-${YEAR}-00001?phone=351912345678`;
    // O token certo ainda funciona antes do bloqueio (as falhas dos testes anteriores contam no mesmo balde).
    expect((await internal(path)).status).toBe(200);
    const statuses: number[] = [];
    for (let i = 0; i < 12 && !statuses.includes(429); i += 1) statuses.push((await internal(path, { authorization: 'Bearer errado-errado-errado-errado-errado-00' })).status);
    expect(statuses.at(-1)).toBe(429);
    expect(statuses.slice(0, -1).every((status) => status === 401)).toBe(true);
    expect((await internal(path)).status).toBe(429);
  }, 60_000);
});
