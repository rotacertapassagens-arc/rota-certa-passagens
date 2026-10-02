/**
 * WHA-04 integrado: formulário do site (Worker real + D1 local isolado) → rota interna → Code nodes do
 * WHA-04 e do WHA-01 exatamente como o build gera para o n8n → Notion em memória → resposta ao cliente.
 * Prova o contrato entre os dois lados com os dados que o site realmente devolve.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unstable_dev, type Unstable_DevWorker } from 'wrangler';
import { QUOTE_CONSENT_VERSION } from '../shared/proposalHandoff.js';
// @ts-expect-error módulo JS de integração (sem tipos)
import { buildWha01, buildWha04 } from '../integrations/n8n/build-wha-site-handoff.mjs';
// @ts-expect-error módulo JS de integração (sem tipos)
import { wha01Skeleton, wha04Skeleton } from '../integrations/n8n/fixtures/workflow-skeletons.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const WRANGLER_BIN = join(REPO_ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const API_TOKEN = 'wha04-integracao-token-0123456789abcdefghij';
const VARS = {
  TOKEN_PEPPER: 'wha04-int-token-pepper-at-least-32-chars-00',
  RATE_LIMIT_SECRET: 'wha04-int-rate-limit-secret-32-characters',
  RESEND_API_KEY: 'unused-in-capture-mode',
  MASTER_BOOTSTRAP_TOKEN: 'wha04-int-bootstrap-token-long-enough-000',
  EMAIL_MODE: 'capture',
  ROTA_CERTA_SITE_API_TOKEN: API_TOKEN,
};
const SUCCESS = (p: string) => `Perfeito! Localizei sua solicitação ${p} e registrei o seu pedido. Nossa equipe vai pesquisar as melhores opções em dinheiro e milhas e continuará o atendimento por aqui. Nenhuma compra ou reserva será feita sem a sua aprovação.`;

type Json = Record<string, any>;
const wha04 = buildWha04(wha04Skeleton());
const wha01 = buildWha01(wha01Skeleton());
const nodeCode = (wf: Json, name: string) => wf.nodes.find((n: Json) => n.name === name)!.parameters.jsCode as string;

/** Executa o texto de um Code node como o n8n: $input, $('Nó') e $env. */
function runCode(jsCode: string, input: Json[], nodes: Record<string, Json>, env: Record<string, string> = {}) {
  const $input = { first: () => ({ json: input[0] }), all: () => input.map((json) => ({ json })) };
  const $ = (name: string) => {
    if (!(name in nodes)) throw new Error(`nó ainda não executado: ${name}`);
    return { item: { json: nodes[name] }, first: () => ({ json: nodes[name] }) };
  };
  return (new Function('$input', '$', '$env', jsCode)($input, $, env) as Array<{ json: Json }>)[0]!.json;
}

/**
 * Notion em memória. A busca devolve TODAS as páginas no formato bruto do nó Notion (simple=false),
 * como o nó vivo fazia quando ignorava o filtro: o WHA-04 tem de achar a página certa sozinho.
 */
class FakeNotion {
  pages = new Map<string, Json>();
  creates = 0;
  constructor() {
    this.pages.set('whatsapp:outro-cliente', { id: 'page-antiga-de-outro-cliente', properties: { 'Submission ID': { rich_text: [{ plain_text: 'whatsapp:outro-cliente' }] } } });
  }
  search() { return this.pages.size ? [...this.pages.values()] : [{}]; }
  create(draft: Json) {
    this.creates += 1;
    const page = { id: `page-${this.creates}`, ...draft.notion, title: draft.title, properties: { 'Submission ID': { rich_text: [{ plain_text: draft.submissionId }] } } };
    this.pages.set(draft.submissionId, page);
    return page;
  }
}

describe('WHA-04 integrado: site → WHA-01 → WHA-04 → Notion → resposta', () => {
  let persistTo: string;
  let worker: Unstable_DevWorker;
  const notion = new FakeNotion();

  beforeAll(async () => {
    persistTo = mkdtempSync(join(tmpdir(), 'rota-certa-wha04-int-'));
    execFileSync(process.execPath, [WRANGLER_BIN, 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', persistTo, '--config', 'wrangler.jsonc'], { cwd: REPO_ROOT, stdio: 'ignore' });
    worker = await unstable_dev('worker/index.ts', { config: 'wrangler.jsonc', local: true, persistTo, vars: VARS, logLevel: 'error', experimental: { disableExperimentalWarning: true } });
  }, 90_000);
  afterAll(async () => {
    if (worker) await worker.stop();
    if (persistTo) rmSync(persistTo, { recursive: true, force: true });
  });

  async function createLead(overrides: Json) {
    const res = await worker.fetch('/api/lead', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      type: 'quote', name: 'Cliente Teste', email: `${crypto.randomUUID()}@example.com`, phone: '+351 912 345 678',
      origem: 'Lisboa', destino: 'São Paulo', ida: '2027-02-10', volta: '2027-02-24', adults: 1, children: 0, infants: 0,
      tipo: 'Ida e volta', cabinClass: 'Econômica', baggage: 'Bagagem de mão', flexibility: 'Datas fixas', paymentPreference: 'Pix',
      contactConsent: true, consentVersion: QUOTE_CONSENT_VERSION, submissionId: crypto.randomUUID(), ...overrides,
    }) });
    const body = await res.json() as Json;
    expect(res.status, JSON.stringify(body)).toBe(201);
    return body as { protocol: string; whatsappUrl: string };
  }

  /** O WHA-04 do n8n, nó a nó: entrada → site (HTTP real) → rascunho → idempotência → Notion. */
  async function runWha04(input: Json) {
    const nodes: Record<string, Json> = {};
    nodes['Validar e Normalizar Entrada'] = runCode(nodeCode(wha04, 'Validar e Normalizar Entrada'), [input], nodes);
    const normalized = nodes['Validar e Normalizar Entrada'];
    let draft: Json;
    if (normalized.needsSiteLookup) {
      const res = await worker.fetch(`/api/internal/proposals/${encodeURIComponent(normalized.protocol)}?phone=${encodeURIComponent(normalized.phone)}`, { headers: { authorization: `Bearer ${API_TOKEN}`, accept: 'application/json' } });
      // O nó HTTP do n8n falha em qualquer resposta que não seja 2xx.
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { code: `SITE_HTTP_${res.status}` });
      draft = runCode(nodeCode(wha04, 'Validar Proposta do Site'), [await res.json() as Json], nodes);
    } else {
      draft = runCode(nodeCode(wha04, 'Preparar Pedido Direto'), [normalized], nodes);
    }
    nodes['Preparar Rascunho'] = draft;
    const decided = runCode(nodeCode(wha04, 'Decidir Idempotência'), notion.search(), nodes);
    if (decided.alreadyExists) return runCode(nodeCode(wha04, 'Retornar Pedido Existente'), [decided], nodes);
    return runCode(nodeCode(wha04, 'Confirmar Persistência'), [notion.create(draft)], nodes);
  }

  /** O desvio do WHA-01: mensagem do WhatsApp → WHA-04 → texto que o cliente recebe. */
  async function whatsappMessage(text: string, senderPhone: string, mode = 'on') {
    const guards = { phone: senderPhone, text, contactName: 'Perfil WhatsApp' };
    const detected = runCode(nodeCode(wha01, 'Detectar Protocolo do Site'), [{ already_processed: false }], { 'Guardas de Entrada': guards }, { WHATSAPP_SITE_HANDOFF_MODE: mode, WHATSAPP_TEST_NUMBER: '351900000000' });
    if (!detected.siteHandoff) return { detected, reply: null };
    let result: Json;
    // O n8n passa o item do nó de detecção inteiro para o WHA-04 (gatilho passthrough).
    try { result = await runWha04(detected); }
    catch (error) { result = { error: { message: (error as Error).message, code: (error as { code?: string }).code } }; }
    const reply = runCode(nodeCode(wha01, 'Preparar Resposta do Site'), [result], { 'Detectar Protocolo do Site': detected });
    return { detected, reply, result };
  }
  const messageOf = (lead: { whatsappUrl: string }) => new URL(lead.whatsappUrl).searchParams.get('text')!;

  it('cidade em texto livre, ida e volta, econômica, item pessoal, sem preferência de escalas: cria uma vez e responde', async () => {
    const lead = await createLead({ baggage: 'Somente item pessoal' });
    const { detected, reply } = await whatsappMessage(messageOf(lead), '351912345678');
    expect(detected).toMatchObject({ siteHandoff: true, siteProtocol: lead.protocol, source: 'SITE_FORM', protocol: lead.protocol });
    expect(reply).toMatchObject({ ok: true, text: SUCCESS(lead.protocol), humanHandoff: false, teamAlert: null });
    expect(reply!.nextState).toMatchObject({ step: 'concluido', collected: { origemPedido: 'SITE_FORM', protocolo: lead.protocol } });
    const page = notion.pages.get(`site:${lead.protocol}`)!;
    expect(page).toMatchObject({ origem: 'Lisboa', destino: 'São Paulo', classe: 'Económica', bagagem: 'Somente item pessoal', vooDireto: false, aceitaEscalas: false, estado: 'Novo', dataVolta: '2027-02-24' });
    expect(JSON.parse(page.pedidoJson).collected).toMatchObject({ tipoViagem: 'ida_e_volta', preferenciaEscalas: 'sem_preferencia', vooDireto: null, aceitaEscalas: null });

    // Protocolo repetido (a pessoa manda a mensagem de novo): localiza, não cria outra página.
    const again = await whatsappMessage(messageOf(lead), '351912345678');
    expect(again.reply).toMatchObject({ ok: true, duplicate: true, text: SUCCESS(lead.protocol) });
    expect([...notion.pages.keys()].filter((key) => key === `site:${lead.protocol}`)).toHaveLength(1);
    expect(notion.creates).toBe(1);
  }, 60_000);

  it('somente ida e todas as classes, bagagens e escalas chegam no formato que o Notion aceita', async () => {
    const cases = [
      { form: { tipo: 'Somente ida', volta: '', cabinClass: 'Premium Economy', baggage: 'Bagagem de mão', stopsPreference: 'Aceito escalas', origem: 'Porto', destino: 'Recife' },
        page: { classe: 'Premium Economy', bagagem: 'Bagagem de mão', vooDireto: false, aceitaEscalas: true, dataVolta: null, origem: 'Porto', destino: 'Recife' }, tipo: 'so_ida', escalas: 'aceita_escalas' },
      { form: { cabinClass: 'Executiva', baggage: 'Bagagem despachada', stopsPreference: 'Somente voo direto', origem: 'opo', destino: 'GRU' },
        page: { classe: 'Executiva', bagagem: 'Bagagem despachada', vooDireto: true, aceitaEscalas: false, origem: 'OPO', destino: 'GRU' }, tipo: 'ida_e_volta', escalas: 'somente_direto' },
      { form: { cabinClass: 'Primeira classe', baggage: 'Ainda não sei', stopsPreference: 'Sem preferência', destino: 'Rio de Janeiro (GIG)' },
        page: { classe: 'Primeira Classe', bagagem: '', vooDireto: false, aceitaEscalas: false, destino: 'Rio de Janeiro (GIG)' }, tipo: 'ida_e_volta', escalas: 'sem_preferencia' },
      { form: { cabinClass: 'Econômica', baggage: 'Bagagem despachada', ida: '2027-03-01', volta: '2027-03-01' },
        page: { classe: 'Económica', dataIda: '2027-03-01', dataVolta: '2027-03-01' }, tipo: 'ida_e_volta', escalas: 'sem_preferencia' },
    ];
    for (const item of cases) {
      const lead = await createLead(item.form);
      const { reply } = await whatsappMessage(messageOf(lead), '351912345678');
      expect(reply, JSON.stringify(item.form)).toMatchObject({ ok: true });
      const page = notion.pages.get(`site:${lead.protocol}`)!;
      expect(page).toMatchObject(item.page);
      expect(JSON.parse(page.pedidoJson).collected).toMatchObject({ tipoViagem: item.tipo, preferenciaEscalas: item.escalas });
    }
  }, 120_000);

  it('telefone divergente ou parcial nunca confirma; celular brasileiro sem o 9 é o mesmo número', async () => {
    const lead = await createLead({ phone: '+55 11 99123-4567' });
    const creates = notion.creates;
    for (const sender of ['5511991234568', '991234567', '351912345678']) {
      const { reply } = await whatsappMessage(messageOf(lead), sender);
      expect(reply, sender).toMatchObject({ ok: false, humanHandoff: true });
      expect(reply!.text).not.toContain('registrei');
      expect(reply!.nextState.step).toBe('aguardando_humano');
      expect(reply!.teamAlert).toContain(lead.protocol);
    }
    expect(notion.creates).toBe(creates);
    // Conta antiga do WhatsApp entrega o número sem o 9: continua sendo o mesmo cliente.
    const legacy = await whatsappMessage(messageOf(lead), '551191234567');
    expect(legacy.reply).toMatchObject({ ok: true, text: SUCCESS(lead.protocol) });
  }, 60_000);

  it('sem o aceite do WhatsApp registrado, o WHA-04 recusa e o cliente não recebe confirmação', async () => {
    const lead = await createLead({ consentVersion: undefined });
    const { reply } = await whatsappMessage(messageOf(lead), '351912345678');
    expect(reply).toMatchObject({ ok: false, humanHandoff: true });
    expect(reply!.teamAlert).toContain('CONSENT_REQUIRED');
    expect(notion.pages.has(`site:${lead.protocol}`)).toBe(false);
  }, 60_000);

  it('o WHA-01 reconhece só a mensagem com protocolo e respeita o modo de ativação', async () => {
    const lead = await createLead({});
    const text = messageOf(lead);
    expect((await whatsappMessage(text, '351912345678', 'off')).detected.siteHandoff).toBe(false);
    expect((await whatsappMessage(text, '351912345678', 'test')).detected.siteHandoff).toBe(false);
    expect((await whatsappMessage(text, '351900000000', 'test')).detected.siteHandoff).toBe(true);
    expect((await whatsappMessage('Quero um orçamento de passagem para Lisboa', '351912345678')).detected.siteHandoff).toBe(false);
    expect((await whatsappMessage(`Oi, segue o protocolo ${lead.protocol.toLowerCase()}`, '351912345678')).detected).toMatchObject({ siteHandoff: true, siteProtocol: lead.protocol });
    expect((await whatsappMessage(`${lead.protocol} e RC-2026-99999, protocolo`, '351912345678')).detected.siteHandoff).toBe(false);
    // Protocolo inexistente: falha fechada, sem confirmação.
    const missing = await whatsappMessage(text.replace(lead.protocol, `RC-${new Date().getUTCFullYear()}-99999`), '351912345678');
    expect(missing.reply).toMatchObject({ ok: false });
    expect(missing.reply!.teamAlert).toContain('SITE_HTTP_404');
  }, 60_000);

  it('o build liga o desvio antes do questionário e mantém o resto do WHA-01', () => {
    const c = wha01.connections;
    expect(c['Primeira Vez (não duplicada)?'].main[0].map((t: Json) => t.node).sort()).toEqual(['Detectar Protocolo do Site', 'Registrar Última Mensagem Recebida']);
    expect(c['É Protocolo do Site?'].main.map((o: Json[]) => o.map((t) => t.node))).toEqual([['Chamar WHA-04 (Site)'], ['GET Estado da Conversa']]);
    expect(c['Chamar WHA-04 (Site)'].main.map((o: Json[]) => o.map((t) => t.node))).toEqual([['Preparar Resposta do Site'], ['Preparar Resposta do Site']]);
    expect(c['GET Estado da Conversa'].main[0][0].node).toBe('Autorizar Início ou Continuidade');
    const call = wha01.nodes.find((n: Json) => n.name === 'Chamar WHA-04 (Site)');
    expect(call).toMatchObject({ onError: 'continueErrorOutput', parameters: { workflowId: { value: 'zFwChhC71hrf6Ycx' }, options: { waitForSubWorkflow: true } } });
    // Rodar o build de novo não duplica nós.
    expect(buildWha01(wha01).nodes.length).toBe(wha01.nodes.length);
    expect(wha04.nodes.find((n: Json) => n.type === 'n8n-nodes-base.executeWorkflowTrigger').parameters).toEqual({ inputSource: 'passthrough' });
    expect(wha04.nodes.find((n: Json) => n.name === 'Buscar Pedido Existente').parameters).toMatchObject({ filterType: 'manual', matchType: 'allFilters' });
    const volta = wha04.nodes.find((n: Json) => n.name === 'Criar Rascunho de Orçamento').parameters.propertiesUi.propertyValues.find((v: Json) => v.key === 'Data volta|date');
    expect(volta.date).toContain("|| ''");
  });
});
