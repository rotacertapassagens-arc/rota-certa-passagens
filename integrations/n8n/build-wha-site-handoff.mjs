// Gera as versões novas do WHA-04 e do WHA-01 a partir dos workflows exportados do n8n vivo.
//
//   node integrations/n8n/build-wha-site-handoff.mjs <WHA01.json> <WHA04.json> <pasta-de-saída>
//
// - WHA-04: troca a biblioteca embutida nos Code nodes por wha04/wha04Logic.js (mesmo "rabo" de cada
//   nó) e fixa o gatilho em "passthrough" (recebe o item do WHA-01 como veio).
// - WHA-01: insere o desvio do protocolo do site logo depois de "Primeira Vez (não duplicada)?". O
//   resto do fluxo continua igual. O desvio só age conforme WHATSAPP_SITE_HANDOFF_MODE (off/test/on).
// Idempotente: rodar de novo sobre um workflow já gerado não duplica nós.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const WHA04_LIB = readFileSync(join(here, 'wha04', 'wha04Logic.js'), 'utf8').trimEnd();
const SITE_LIB = readFileSync(join(here, 'wha01', 'siteHandoff.js'), 'utf8').trimEnd();
export const WHA04_WORKFLOW_ID = 'zFwChhC71hrf6Ycx';

const one = (parsed) => (Array.isArray(parsed) ? parsed[0] : parsed);

// A busca no Notion pode devolver páginas que não são do pedido (achado real em 2026-10-01: sem
// filterType "manual" o nó ignorava o filtro e devolvia a primeira página da base). Só conta como
// "já existe" a página cujo Submission ID é exatamente o deste pedido.
const DECIDE_IDEMPOTENCY = `const draft = $('Preparar Rascunho').first().json;
function submissionOf(page) {
  const prop = page && page.properties ? page.properties['Submission ID'] : null;
  const parts = (prop && (prop.rich_text || prop.title)) || [];
  return parts.map((part) => part.plain_text || (part.text && part.text.content) || '').join('').trim();
}
const match = $input.all().map((item) => item.json).find((page) => page && page.id && submissionOf(page) === draft.submissionId);
const existingPageId = match ? match.id : null;
return [{ json: { ...draft, alreadyExists: Boolean(existingPageId), existingPageId } }];`;

export function buildWha04(source) {
  const wf = structuredClone(one(source));
  for (const node of wf.nodes) {
    if (node.type === 'n8n-nodes-base.executeWorkflowTrigger') node.parameters = { inputSource: 'passthrough' };
    if (node.name === 'Buscar Pedido Existente') Object.assign(node.parameters, { filterType: 'manual', matchType: 'allFilters' });
    if (node.name === 'Decidir Idempotência') node.parameters.jsCode = DECIDE_IDEMPOTENCY;
    // Só ida: o nó Notion só deixa a data vazia com '' (null vira "Invalid date" e o Notion recusa).
    const volta = node.parameters?.propertiesUi?.propertyValues?.find((value) => value.key === 'Data volta|date');
    if (volta) volta.date = "={{ $('Preparar Rascunho').item.json.notion.dataVolta || '' }}";
    const code = node.parameters?.jsCode;
    if (typeof code !== 'string' || !code.includes('function buildSafeResult')) continue;
    const start = code.lastIndexOf('\nfunction buildSafeResult');
    const tail = code.slice(code.indexOf('\n}\n', start) + 3);
    node.parameters.jsCode = `${WHA04_LIB}\n${tail.startsWith('\n') ? tail : `\n${tail}`}`;
  }
  return wf;
}

const SITE_NODE_NAMES = [
  'Detectar Protocolo do Site', 'É Protocolo do Site?', 'Chamar WHA-04 (Site)', 'Preparar Resposta do Site',
  'PUT Salvar Estado (Site)', 'Avisar Equipe? (Site)', 'Telegram Aviso (Site)', 'Atendimento Ativo? (Site)',
  'Enviar Resposta via UAZAPI (Site)', 'Registrar Última Resposta Enviada (Site)',
];

const DETECT_TAIL = `
// O item que chega é a resposta do claim de idempotência; os dados da mensagem vêm das guardas.
const mensagem = $('Guardas de Entrada').first().json;
const deteccao = detectSiteHandoff(mensagem.text);
const permitido = deteccao.matched && siteHandoffAllowed(mensagem.phone, {
  mode: $env.WHATSAPP_SITE_HANDOFF_MODE || 'off',
  testNumber: $env.WHATSAPP_TEST_NUMBER || null,
});
return [{ json: {
  ...$input.first().json,
  siteHandoff: permitido,
  siteProtocol: permitido ? deteccao.protocol : null,
  phone: mensagem.phone,
  contactName: mensagem.contactName || null,
} }];`;

const REPLY_TAIL = `
// Chega pela saída de sucesso (resultado do WHA-04) ou pela de erro (o WHA-04 falhou ou não confirmou).
const pedido = $('Detectar Protocolo do Site').first().json;
const recebido = $input.first().json || {};
const erro = recebido.error ? (typeof recebido.error === 'object' ? recebido.error : { message: String(recebido.error) }) : null;
const resposta = buildSiteHandoffReply({
  protocol: pedido.siteProtocol,
  phone: pedido.phone,
  contactName: pedido.contactName,
  result: erro ? null : recebido,
  error: erro,
});
return [{ json: resposta }];`;

function siteNodes(base) {
  const [x, y] = base;
  const workerAuth = { httpHeaderAuth: { id: 'uMnKqJwnpyDXcZfQ', name: 'ORC Worker Local' } };
  const ifTrue = (id, left) => ({
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
      conditions: [{ id, leftValue: left, rightValue: true, operator: { type: 'boolean', operation: 'equals' } }],
      combinator: 'and',
    },
    options: {},
  });
  return [
    { id: 'site-0001-detect', name: 'Detectar Protocolo do Site', type: 'n8n-nodes-base.code', typeVersion: 2, position: [x, y],
      parameters: { jsCode: `${SITE_LIB}\n${DETECT_TAIL}` } },
    { id: 'site-0002-if', name: 'É Protocolo do Site?', type: 'n8n-nodes-base.if', typeVersion: 2.3, position: [x + 220, y],
      parameters: ifTrue('cond-site-handoff', '={{ $json.siteHandoff }}') },
    { id: 'site-0003-wha04', name: 'Chamar WHA-04 (Site)', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.2, position: [x + 440, y - 400],
      onError: 'continueErrorOutput',
      notes: 'Só confirma ao cliente depois que o WHA-04 devolve a página do Notion. Falha cai na saída de erro.',
      parameters: {
        source: 'database',
        workflowId: { __rl: true, value: WHA04_WORKFLOW_ID, mode: 'id' },
        mode: 'once',
        options: { waitForSubWorkflow: true },
      } },
    { id: 'site-0004-reply', name: 'Preparar Resposta do Site', type: 'n8n-nodes-base.code', typeVersion: 2, position: [x + 660, y - 400],
      parameters: { jsCode: `${SITE_LIB}\n${REPLY_TAIL}` } },
    { id: 'site-0005-put', name: 'PUT Salvar Estado (Site)', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.5, position: [x + 880, y - 400],
      credentials: workerAuth, onError: 'continueRegularOutput',
      parameters: {
        method: 'PUT',
        url: "=http://orc-worker:8770/whatsapp/conversations/{{ $('Preparar Resposta do Site').first().json.phone }}",
        authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
        sendHeaders: true, headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
        sendBody: true, contentType: 'json', specifyBody: 'json',
        jsonBody: "={{ JSON.stringify({ state: $('Preparar Resposta do Site').first().json.nextState, human_handoff: $('Preparar Resposta do Site').first().json.humanHandoff, paused_until: null }) }}",
        options: { timeout: 10000 },
      } },
    { id: 'site-0006-alert-if', name: 'Avisar Equipe? (Site)', type: 'n8n-nodes-base.if', typeVersion: 2.3, position: [x + 1100, y - 400],
      parameters: ifTrue('cond-site-alert', "={{ Boolean($('Preparar Resposta do Site').first().json.teamAlert) }}") },
    { id: 'site-0007-telegram', name: 'Telegram Aviso (Site)', type: 'n8n-nodes-base.telegram', typeVersion: 1.2, position: [x + 1320, y - 560],
      credentials: { telegramApi: { id: 'QoYWE2NRWvkHiUbI', name: 'Telegram — Aprovações Rota Certa' } },
      retryOnFail: true, maxTries: 3, waitBetweenTries: 2000, onError: 'continueRegularOutput',
      webhookId: 'b6d7c5a4-31e2-4f0a-9c8d-5a4b3c2d1e0f',
      parameters: { chatId: '={{ $env.TELEGRAM_CHAT_ID }}', text: "={{ $('Preparar Resposta do Site').first().json.teamAlert }}", additionalFields: {} } },
    { id: 'site-0008-active-if', name: 'Atendimento Ativo? (Site)', type: 'n8n-nodes-base.if', typeVersion: 2.3, position: [x + 1540, y - 400],
      parameters: ifTrue('cond-site-switch', "={{ $('Restaurar Dados + Aplicar Switch').first().json.atendimentoAtivo }}") },
    { id: 'site-0009-send', name: 'Enviar Resposta via UAZAPI (Site)', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.5, position: [x + 1760, y - 400],
      parameters: {
        method: 'POST', url: '={{ $env.UAZAPI_BASE_URL }}/send/text',
        sendHeaders: true,
        headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }, { name: 'token', value: '={{ $env.UAZAPI_TOKEN }}' }] },
        sendBody: true, contentType: 'json', specifyBody: 'json',
        jsonBody: "={{ JSON.stringify({ number: $('Preparar Resposta do Site').first().json.phone, text: $('Preparar Resposta do Site').first().json.text }) }}",
        options: { timeout: 10000 },
      } },
    { id: 'site-0010-track', name: 'Registrar Última Resposta Enviada (Site)', type: 'n8n-nodes-base.notion', typeVersion: 3, position: [x + 1980, y - 400],
      credentials: { notionApi: { id: 'IKIuUx2GsqcZU1DO', name: 'Notion account' } }, onError: 'continueRegularOutput',
      parameters: {
        resource: 'databasePage', operation: 'update',
        pageId: { __rl: true, value: '3cab1637-ebd5-8162-aaab-dea45a5969de', mode: 'id' },
        propertiesUi: { propertyValues: [{ key: 'Última Resposta Enviada|date', date: '={{ $now.toISO() }}', includeTime: true }] },
        options: {},
      } },
  ];
}

export function buildWha01(source) {
  const wf = structuredClone(one(source));
  wf.nodes = wf.nodes.filter((node) => !SITE_NODE_NAMES.includes(node.name));
  for (const name of SITE_NODE_NAMES) delete wf.connections[name];
  const gate = wf.nodes.find((node) => node.name === 'Primeira Vez (não duplicada)?');
  const getState = wf.nodes.find((node) => node.name === 'GET Estado da Conversa');
  if (!gate || !getState) throw new Error('WHA-01 sem os nós esperados (Primeira Vez / GET Estado da Conversa)');
  wf.nodes.push(...siteNodes([gate.position[0] + 220, gate.position[1] + 260]));

  // Primeira Vez (true) -> Detectar (no lugar de GET Estado), mantendo o registro da mensagem recebida.
  const trueBranch = wf.connections['Primeira Vez (não duplicada)?'].main[0];
  const getIndex = trueBranch.findIndex((target) => target.node === 'GET Estado da Conversa' || target.node === 'Detectar Protocolo do Site');
  if (getIndex === -1) throw new Error('Ligação Primeira Vez -> GET Estado da Conversa não encontrada');
  trueBranch[getIndex] = { node: 'Detectar Protocolo do Site', type: 'main', index: 0 };

  const link = (node) => [{ node, type: 'main', index: 0 }];
  Object.assign(wf.connections, {
    'Detectar Protocolo do Site': { main: [link('É Protocolo do Site?')] },
    'É Protocolo do Site?': { main: [link('Chamar WHA-04 (Site)'), link('GET Estado da Conversa')] },
    'Chamar WHA-04 (Site)': { main: [link('Preparar Resposta do Site'), link('Preparar Resposta do Site')] },
    'Preparar Resposta do Site': { main: [link('PUT Salvar Estado (Site)')] },
    'PUT Salvar Estado (Site)': { main: [link('Avisar Equipe? (Site)')] },
    'Avisar Equipe? (Site)': { main: [link('Telegram Aviso (Site)'), link('Atendimento Ativo? (Site)')] },
    'Telegram Aviso (Site)': { main: [link('Atendimento Ativo? (Site)')] },
    'Atendimento Ativo? (Site)': { main: [link('Enviar Resposta via UAZAPI (Site)'), []] },
    'Enviar Resposta via UAZAPI (Site)': { main: [link('Registrar Última Resposta Enviada (Site)')] },
  });
  return wf;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [wha01Path, wha04Path, outDir] = process.argv.slice(2);
  if (!wha01Path || !wha04Path || !outDir) throw new Error('uso: build-wha-site-handoff.mjs <WHA01.json> <WHA04.json> <saída>');
  mkdirSync(outDir, { recursive: true });
  const wha01 = buildWha01(JSON.parse(readFileSync(wha01Path, 'utf8')));
  const wha04 = buildWha04(JSON.parse(readFileSync(wha04Path, 'utf8')));
  writeFileSync(join(outDir, 'WHA01ReceberPedidos.json'), JSON.stringify(wha01, null, 2));
  writeFileSync(join(outDir, `${WHA04_WORKFLOW_ID}.json`), JSON.stringify(wha04, null, 2));
  console.log(JSON.stringify({ wha01Nodes: wha01.nodes.length, wha04Nodes: wha04.nodes.length, outDir }));
}
