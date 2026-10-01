// WHA-01: mensagem do botão "Continuar atendimento pelo WhatsApp" do site - lógica pura, sem I/O.
//
// Fonte única do código embutido nos Code nodes "Detectar Protocolo do Site" e "Preparar Resposta do
// Site" do workflow "WHA-01 — Receber Pedidos pelo WhatsApp" (ver ../build-wha-site-handoff.mjs). Sem
// import/export de propósito: o build cola este arquivo no Code node e os testes carregam com node:vm.
//
// Detecção determinística, sem IA: a mensagem pronta do site, com exatamente um protocolo
// RC-AAAA-NNNNN. Se a pessoa mexer no texto, ainda vale quando sobra a palavra "protocolo" e um único
// protocolo; qualquer outra coisa segue o fluxo normal do WHA-01.

const SITE_HANDOFF_TEMPLATE =
  "Olá! Acabei de enviar uma solicitação de orçamento pelo site da Rota Certa. Meu protocolo é {protocol}. Quero continuar o atendimento pelo WhatsApp.";

const SITE_HANDOFF_SUCCESS_TEMPLATE =
  "Perfeito! Localizei sua solicitação {protocol} e registrei o seu pedido. Nossa equipe vai pesquisar as melhores opções em dinheiro e milhas e continuará o atendimento por aqui. Nenhuma compra ou reserva será feita sem a sua aprovação.";

// Falha do site ou do Notion: nunca confirma registro. Só avisa que a equipe vai conferir.
const SITE_HANDOFF_FAILURE_TEMPLATE =
  "Recebemos a sua mensagem com o protocolo {protocol}. Nossa equipe vai conferir a sua solicitação e responder por aqui em breve.";

function normalizeHandoffText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9{}\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const SITE_HANDOFF_TEMPLATE_KEY = normalizeHandoffText(SITE_HANDOFF_TEMPLATE);

/** @returns {{ matched: boolean, protocol: string|null, exactTemplate: boolean }} */
function detectSiteHandoff(text) {
  const raw = String(text || "");
  const found = raw.match(/\bRC-\d{4}-\d{5,}\b/gi) || [];
  const protocols = [...new Set(found.map((value) => value.toUpperCase()))];
  if (protocols.length !== 1) return { matched: false, protocol: null, exactTemplate: false };
  const protocol = protocols[0];
  const withPlaceholder = normalizeHandoffText(raw.replace(/\bRC-\d{4}-\d{5,}\b/gi, "{protocol}"));
  const exactTemplate = withPlaceholder === SITE_HANDOFF_TEMPLATE_KEY;
  const mentionsProtocol = /\bprotocolo\b/.test(withPlaceholder);
  if (!exactTemplate && !mentionsProtocol) return { matched: false, protocol: null, exactTemplate: false };
  return { matched: true, protocol, exactTemplate };
}

/**
 * Liga/desliga o caminho do site sem mexer no fluxo normal:
 * "off" (padrão) nunca desvia; "test" só desvia o número de teste; "on" desvia todos.
 */
function siteHandoffAllowed(phone, { mode = "off", testNumber = null } = {}) {
  const current = String(mode || "off").trim().toLowerCase();
  if (current === "on") return true;
  if (current === "test") return Boolean(testNumber) && String(phone) === String(testNumber);
  return false;
}

function fillProtocol(template, protocol) {
  return template.replace("{protocol}", protocol);
}

/**
 * Decide a resposta ao cliente a partir do retorno do WHA-04. Só confirma quando o WHA-04 devolveu
 * accepted=true com o id da página do Notion (criada agora ou já existente).
 */
function buildSiteHandoffReply({ protocol, phone, contactName = null, result = null, error = null }) {
  const ok = !error && result && result.accepted === true && typeof result.notionPageId === "string" && result.notionPageId.length > 0
    && String(result.protocol || "").toUpperCase() === String(protocol).toUpperCase();
  const collected = { origemPedido: "SITE_FORM", protocolo: protocol, nome: contactName || undefined };
  if (ok) {
    return {
      ok: true,
      phone,
      text: fillProtocol(SITE_HANDOFF_SUCCESS_TEMPLATE, protocol),
      // "concluido": o motor do WHA-01 responde "pedido já recebido" e nunca reinicia o questionário.
      nextState: { step: "concluido", collected: { ...collected, notionPageId: result.notionPageId } },
      humanHandoff: false,
      teamAlert: null,
      duplicate: Boolean(result.duplicate),
    };
  }
  const reason = error ? String(error.code || error.message || error).slice(0, 300) : "resposta_sem_confirmacao";
  return {
    ok: false,
    phone,
    text: fillProtocol(SITE_HANDOFF_FAILURE_TEMPLATE, protocol),
    // Equipe assume: o bot fica pausado para este número e não abre o questionário.
    nextState: { step: "aguardando_humano", collected: { ...collected, erroSite: reason } },
    humanHandoff: true,
    teamAlert: `⚠️ WHA-04: não consegui vincular o protocolo ${protocol} do site ao WhatsApp +${phone}${contactName ? ` (${contactName})` : ""}. Motivo: ${reason}. O cliente recebeu só um aviso de que a equipe vai conferir; nenhum orçamento foi confirmado. Atendimento humano necessário.`,
    duplicate: false,
  };
}
