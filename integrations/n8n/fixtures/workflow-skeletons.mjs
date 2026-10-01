// Esqueletos sintéticos do WHA-01 e do WHA-04, só com a estrutura que o build altera (nomes dos nós,
// ligações e o "rabo" de cada Code node do WHA-04). Não contêm dados nem segredos de produção: os
// workflows vivos são exportados do n8n na hora do deploy e nunca entram no repositório.

const OLD_LIB = 'function buildSafeResult(draft, pageId, duplicate = false) {\n  return { old: true };\n}\n';
const code = (name, tail) => ({ id: name, name, type: 'n8n-nodes-base.code', typeVersion: 2, position: [0, 0], parameters: { jsCode: `${OLD_LIB}${tail}` } });

export function wha04Skeleton() {
  return {
    id: 'zFwChhC71hrf6Ycx',
    name: 'WHA-04 — Criar e Vincular Orçamentos',
    active: false,
    nodes: [
      { id: 't', name: 'Chamado pelo WHA-01', type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1.1, position: [0, 0], parameters: {} },
      code('Validar e Normalizar Entrada', '\nconst input = $input.first()?.json || {};\nreturn [{ json: normalizeWha04Input(input) }];'),
      code('Validar Proposta do Site', "\nconst normalized = $('Validar e Normalizar Entrada').item.json;\nconst proposal = $input.first()?.json || null;\nreturn [{ json: buildNotionDraft(mergeSiteProposal(normalized, proposal)) }];"),
      code('Preparar Pedido Direto', '\nreturn [{ json: buildNotionDraft($input.first().json) }];'),
      code('Retornar Pedido Existente', '\nconst item = $input.first().json;\nreturn [{ json: buildSafeResult(item, item.existingPageId, true) }];'),
      code('Confirmar Persistência', "\nconst draft = $('Preparar Rascunho').item.json;\nconst created = $input.first()?.json || {};\nreturn [{ json: buildSafeResult(draft, created.id, false) }];"),
      { id: 'd', name: 'Decidir Idempotência', type: 'n8n-nodes-base.code', typeVersion: 2, position: [0, 0], parameters: { jsCode: "const draft = $('Preparar Rascunho').item.json;\nconst candidate = $input.first()?.json || {};\nconst existingPageId = candidate.id || null;\nreturn [{ json: { ...draft, alreadyExists: Boolean(existingPageId), existingPageId } }];" } },
    ],
    connections: {},
    settings: { executionOrder: 'v1' },
  };
}

export function wha01Skeleton() {
  const node = (name, type = 'n8n-nodes-base.code', position = [0, 0]) => ({ id: name, name, type, typeVersion: 2, position, parameters: {} });
  return {
    id: 'WHA01ReceberPedidos',
    name: 'WHA-01 — Receber Pedidos pelo WhatsApp',
    active: true,
    nodes: [
      node('Guardas de Entrada'),
      node('Restaurar Dados + Aplicar Switch'),
      node('Primeira Vez (não duplicada)?', 'n8n-nodes-base.if', [1100, -100]),
      node('GET Estado da Conversa', 'n8n-nodes-base.httpRequest'),
      node('Registrar Última Mensagem Recebida', 'n8n-nodes-base.notion'),
      node('Autorizar Início ou Continuidade'),
    ],
    connections: {
      'Restaurar Dados + Aplicar Switch': { main: [[{ node: 'Primeira Vez (não duplicada)?', type: 'main', index: 0 }]] },
      'Primeira Vez (não duplicada)?': { main: [[
        { node: 'GET Estado da Conversa', type: 'main', index: 0 },
        { node: 'Registrar Última Mensagem Recebida', type: 'main', index: 0 },
      ], []] },
      'GET Estado da Conversa': { main: [[{ node: 'Autorizar Início ou Continuidade', type: 'main', index: 0 }]] },
    },
    settings: { executionOrder: 'v1' },
  };
}
